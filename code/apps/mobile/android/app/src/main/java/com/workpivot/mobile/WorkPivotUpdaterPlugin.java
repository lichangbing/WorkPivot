package com.workpivot.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/** 只接受与当前安装签名一致、摘要和版本匹配的 APK，最终安装由 Android 系统确认。 */
@CapacitorPlugin(name = "WorkPivotUpdater")
public class WorkPivotUpdaterPlugin extends Plugin {
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = packageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("packageName", getContext().getPackageName());
            result.put("versionName", info.versionName);
            result.put("versionCode", versionCode(info));
            result.put("signerSha256", signerDigest(getContext().getPackageName(), null));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取当前客户端版本", "VERSION_UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        String packageName = call.getString("packageName");
        String expectedSigner = call.getString("signerSha256");
        Integer expectedBuild = call.getInt("build");
        if (url == null || !url.startsWith("https://")) {
            call.reject("更新地址必须是 HTTPS", "UNSAFE_URL");
            return;
        }
        if (packageName == null || !packageName.equals(getContext().getPackageName())) {
            call.reject("更新包不属于当前应用", "PACKAGE_MISMATCH");
            return;
        }
        if (expectedSha256 == null || !expectedSha256.matches("(?i)^[a-f0-9]{64}$")) {
            call.reject("更新包摘要无效", "HASH_INVALID");
            return;
        }
        if (expectedSigner == null || !expectedSigner.matches("(?i)^[a-f0-9]{64}$") || expectedBuild == null) {
            call.reject("更新包签名或版本信息无效", "UPDATE_METADATA_INVALID");
            return;
        }
        getBridge().execute(() -> {
            try {
                PackageInfo current = packageInfo(packageName, 0);
                if (expectedBuild <= versionCode(current)) {
                    call.reject("当前版本不需要更新", "NO_UPGRADE");
                    return;
                }
                if (!expectedSigner.equalsIgnoreCase(signerDigest(packageName, null))) {
                    call.reject("更新清单签名与当前应用不一致", "SIGNER_MISMATCH");
                    return;
                }
                File directory = new File(getContext().getCacheDir(), "workpivot-updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建更新目录");
                File target = new File(directory, "WorkPivot-" + expectedBuild + ".apk");
                if (!target.isFile() || !hash(target).equalsIgnoreCase(expectedSha256)) {
                    download(url, target, expectedSha256);
                }
                PackageInfo archive = packageInfo(packageName, 0, target);
                if (archive == null || !packageName.equals(archive.packageName) || versionCode(archive) != expectedBuild) {
                    target.delete();
                    call.reject("下载文件不是预期版本", "APK_METADATA_MISMATCH");
                    return;
                }
                if (!expectedSigner.equalsIgnoreCase(signerDigest(packageName, target))) {
                    target.delete();
                    call.reject("下载文件签名校验失败", "APK_SIGNER_MISMATCH");
                    return;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent settings = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + packageName)
                    );
                    getActivity().startActivity(settings);
                    JSObject result = new JSObject();
                    result.put("status", "permission-required");
                    call.resolve(result);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    packageName + ".fileprovider",
                    target
                );
                Intent installer = new Intent(Intent.ACTION_VIEW);
                installer.setDataAndType(uri, "application/vnd.android.package-archive");
                installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(installer);
                JSObject result = new JSObject();
                result.put("status", "installer-opened");
                call.resolve(result);
            } catch (Exception error) {
                call.reject("下载或校验更新失败，请检查网络后重试", "DOWNLOAD_FAILED", error);
            }
        });
    }

    private PackageInfo packageInfo(String packageName, int flags) throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(packageName, flags);
    }

    private PackageInfo packageInfo(String packageName, int flags, File apk) {
        return getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
    }

    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private String signerDigest(String packageName, File apk) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int signingFlag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo info = apk == null
            ? manager.getPackageInfo(packageName, signingFlag)
            : manager.getPackageArchiveInfo(apk.getAbsolutePath(), signingFlag);
        if (info == null) throw new Exception("无法读取签名");
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signing = info.signingInfo;
            if (signing == null) throw new Exception("更新包未签名");
            signatures = signing.hasMultipleSigners()
                ? signing.getApkContentsSigners()
                : signing.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length != 1) throw new Exception("更新包签名数量无效");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] value = digest.digest(signatures[0].toByteArray());
        StringBuilder text = new StringBuilder(value.length * 2);
        for (byte item : value) text.append(String.format(Locale.ROOT, "%02x", item));
        return text.toString();
    }

    private void download(String address, File target, String expectedSha256) throws Exception {
        File partial = new File(target.getAbsolutePath() + ".part");
        long offset = partial.isFile() ? partial.length() : 0;
        if (offset > MAX_BYTES) {
            partial.delete();
            offset = 0;
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK && status != HttpURLConnection.HTTP_PARTIAL) {
            connection.disconnect();
            throw new Exception("更新服务器返回 " + status);
        }
        if (status == HttpURLConnection.HTTP_OK) offset = 0;
        long expectedLength = connection.getContentLengthLong();
        if (offset + Math.max(0, expectedLength) > MAX_BYTES) {
            connection.disconnect();
            throw new Exception("更新包超过大小限制");
        }
        try (InputStream input = connection.getInputStream();
             FileOutputStream output = new FileOutputStream(partial, offset > 0)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                output.write(buffer, 0, count);
                if (partial.length() > MAX_BYTES) throw new Exception("更新包超过大小限制");
            }
            output.getFD().sync();
        } finally {
            connection.disconnect();
        }
        String actual = hash(partial);
        if (!actual.equalsIgnoreCase(expectedSha256)) {
            partial.delete();
            throw new Exception("更新包摘要不匹配");
        }
        if (target.isFile() && !target.delete()) throw new Exception("无法替换旧更新包");
        if (!partial.renameTo(target)) throw new Exception("无法保存更新包");
    }

    private String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        StringBuilder text = new StringBuilder(64);
        for (byte item : digest.digest()) text.append(String.format(Locale.ROOT, "%02x", item));
        return text.toString();
    }
}
