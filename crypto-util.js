/**
 * crypto-util.js
 * 与 APP 端 ApiListManager.encryptUrl/decryptUrl 完全一致的对称加密：
 *   XOR 逐字节 + Base64（NO_WRAP，即标准 Base64 无换行）。
 * 用途：服务端把 TURN 凭证用「与后台加密秘钥一致的 ENCRYPT_KEY」加密后下发，
 * APP 端用同一把秘钥（后台设置的「加密秘钥」）解密，避免明文暴露 TURN 长期凭证。
 */

/**
 * 加密：明文 text -> Base64 字符串
 * @param {string} text 待加密明文
 * @param {string} key  加密密钥（utf8）
 * @returns {string} Base64 字符串
 */
function xorBase64(text, key) {
    const keyBytes = Buffer.from(key, 'utf8');
    const textBytes = Buffer.from(text, 'utf8');
    const out = Buffer.alloc(textBytes.length);
    for (let i = 0; i < textBytes.length; i++) {
        out[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return out.toString('base64');
}

/**
 * 解密：Base64 字符串 -> 明文
 * @param {string} b64 Base64 密文
 * @param {string} key 解密密钥（utf8）
 * @returns {string} 明文
 */
function decryptXorBase64(b64, key) {
    const keyBytes = Buffer.from(key, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
        out[i] = buf[i] ^ keyBytes[i % keyBytes.length];
    }
    return out.toString('utf8');
}

module.exports = { xorBase64, decryptXorBase64 };
