/**
 * Une IPv6 écrite en entier (`0000:0000:…:0001`, telle que Better Auth la
 * range) sous sa forme courte (`::1`) : la plus longue suite de groupes nuls
 * devient `::`, les zéros de tête tombent. Une IPv4 passe telle quelle.
 */
export function compactIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (!ip.includes(':') || ip.includes('::') || ip.includes('.')) return ip;
  const groups = ip.split(':');
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return ip;
  const short = groups.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase());

  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && short[start + length] === '0') length += 1;
    if (length > best.length) best = { start, length };
  }
  if (best.length < 2) return short.join(':');
  const head = short.slice(0, best.start).join(':');
  const tail = short.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}
