/**
 * T1-07：密钥加密边界。密钥不以明文落盘（I04）。
 * SecretBox 由宿主注入：Electron 主进程用 safeStorage（DPAPI/Keychain）；
 * 纯 Node 开发态回退 base64（仅供调试，接受密钥扫描测试的部署必须走桌面形态）。
 */

export interface SecretEnvelope {
  enc: 'safeStorage' | 'b64';
  data: string;
}

export interface SecretBox {
  encrypt(plain: string): SecretEnvelope;
  decrypt(envelope: SecretEnvelope): string;
}

const b64Box: SecretBox = {
  encrypt: (plain) => ({ enc: 'b64', data: Buffer.from(plain, 'utf8').toString('base64') }),
  decrypt: (envelope) => Buffer.from(envelope.data, 'base64').toString('utf8'),
};

let box: SecretBox = b64Box;

/** 宿主（Electron main）启动时注入 safeStorage 实现。 */
export function setSecretBox(impl: SecretBox): void {
  box = impl;
}

export function getSecretBox(): SecretBox {
  return box;
}
