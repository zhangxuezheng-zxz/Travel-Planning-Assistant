/**
 * 大模型入口地址的安全约束（B 的行程排序与对话共用）。
 *
 * 允许：
 * - `https:` 任意主机；
 * - `http:` 仅本机（`localhost`、`127.0.0.1`、`[::1]`），便于本地 ollama 等自建服务。
 *
 * 拒绝：非 http(s) 协议、URL 内嵌凭据、查询串与片段。
 * 这些位置容易被塞进代理地址或第三方参数，也会让日志泄露不该出现的内容。
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function validLlmBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
}
