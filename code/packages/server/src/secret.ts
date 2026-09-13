/**
 * T1-07：密钥加密边界。密钥不以明文落盘（I04）。
 * SecretBox 由宿主注入：Electron 主进程用 safeStorage（DPAPI/Keychain）；
 * 纯 Node 开发态回退 base64（仅供调试，接受密钥扫描测试的部署必须走桌面形态）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretEnvelope {
  enc: 'safeStorage' | 'b64' | 'aes-256-gcm';
  data: string;
}

export interface SecretBox {
  encrypt(plain: string): SecretEnvelope;
  decrypt(envelope: SecretEnvelope): string;
}

const b64Box: SecretBox = {
  encrypt: (plain) => ({ enc: 'b64', data: Buffer.from(plain, 'utf8').toString('base64') }),
  decrypt: (envelope) => {
    if (envelope.enc !== 'b64') throw new Error('密文需要原部署的加密密钥');
    return Buffer.from(envelope.data, 'base64').toString('utf8');
  },
};

let box: SecretBox | undefined;
let hostInjected = false;

export function createAesBox(keyHex: string): SecretBox {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('WORKPIVOT_SECRET_KEY 必须是 32 字节随机密钥的 64 位十六进制文本');
  const key = Buffer.from(keyHex, 'hex');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return { enc: 'aes-256-gcm', data: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
    },
    decrypt(envelope) {
      if (envelope.enc !== 'aes-256-gcm') throw new Error('密钥格式不兼容，请先迁移');
      const bytes = Buffer.from(envelope.data, 'base64');
      if (bytes.length < 28) throw new Error('密钥密文损坏');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

export function initializeSecretBox(): void {
  if (hostInjected) return;
  const key = process.env['WORKPIVOT_SECRET_KEY'];
  if (key) box = createAesBox(key);
  else if (process.env['WORKPIVOT_INSECURE_SECRETS'] === '1') box = b64Box;
  else throw new Error('缺少 WORKPIVOT_SECRET_KEY；仅本机开发可显式设置 WORKPIVOT_INSECURE_SECRETS=1');
}

/** 宿主（Electron main）启动时注入 safeStorage 实现。 */
export function setSecretBox(impl: SecretBox): void {
  box = impl;
  hostInjected = true;
}

export function getSecretBox(): SecretBox {
  if (!box) initializeSecretBox();
  return box!;
}
