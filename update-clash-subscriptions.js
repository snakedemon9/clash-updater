#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const DEFAULT_GROUPS = {
  all: ["🚀 手动选择"],
  auto: ["♻️ 自动选择", "自动选择2⚡️"],
  featured: ["📍精选测速"],
  hk: ["🇭🇰 香港节点", "🇭🇰香港选择"],
  jp: ["🇯🇵 日本测速", "🇯🇵日本选择"],
  kr: ["🇰🇷韩国测速", "🇰🇷韩国节点"],
  us: ["🇺🇲 美国节点"],
  sg: ["🇸🇬 新加坡节点"],
  tw: ["🇰🇵台湾节点"],
  th: ["🇨🇿泰国节点"],
  other: ["🌏其他国家", "💫其他节点"],
};

const args = parseArgs(process.argv.slice(2));

async function main() {
  if (!args.base || !args.out || args.sub.length === 0) {
    usage();
    process.exitCode = 2;
    return;
  }

  const baseText = fs.readFileSync(args.base, "utf8");
  const doc = YAML.parseDocument(baseText, {
    keepSourceTokens: true,
    prettyErrors: true,
  });
  const config = doc.toJS();

  if (!Array.isArray(config.proxies)) {
    throw new Error("Base config does not contain a proxies array.");
  }
  if (!Array.isArray(config["proxy-groups"])) {
    throw new Error("Base config does not contain a proxy-groups array.");
  }

  const fetched = [];
  for (const source of args.sub) {
    const content = await readSource(source);
    const nodes = parseSubscription(content, source);
    if (nodes.length === 0) {
      throw new Error(`No proxies found in subscription: ${source}`);
    }
    fetched.push(...nodes);
  }

  const newProxies = uniqueByName(fetched.map(normalizeProxyName).filter(isUsableProxy));
  const newNames = newProxies.map((proxy) => proxy.name);
  const oldNames = new Set(config.proxies.map((proxy) => proxy && proxy.name).filter(Boolean));

  config.proxies = args.replaceAll
    ? newProxies
    : args.preserveGroups
      ? replaceProviderProxies(config.proxies, newProxies, args.oldProviderPattern)
      : mergeProxies(config.proxies, newProxies, args.replaceGroup, config["proxy-groups"]);

  const activeNewNames = args.replaceAll
    ? newNames
    : newNames.filter((name) => !oldNames.has(name) || config.proxies.some((proxy) => proxy.name === name));

  if (args.preserveGroups) {
    preserveGroupComposition(config["proxy-groups"], activeNewNames, args.oldProviderPattern);
  } else {
    updateGroups(config["proxy-groups"], activeNewNames, args);
  }
  doc.set("proxies", config.proxies);
  doc.set("proxy-groups", config["proxy-groups"]);

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, String(doc), "utf8");

  console.log(`Wrote ${args.out}`);
  console.log(`Fetched ${newProxies.length} proxies from ${args.sub.length} subscription(s).`);
}

function parseArgs(argv) {
  const result = {
    sub: [],
    replaceAll: false,
    replaceGroup: "",
    preserveGroups: false,
    oldProviderPattern: "^vv",
    providerGroup: "🍀huaheban",
    base: "",
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") result.base = argv[++i];
    else if (arg === "--out") result.out = argv[++i];
    else if (arg === "--sub") result.sub.push(argv[++i]);
    else if (arg === "--replace-all") result.replaceAll = true;
    else if (arg === "--replace-from-group") result.replaceGroup = argv[++i];
    else if (arg === "--preserve-groups") result.preserveGroups = true;
    else if (arg === "--old-provider-pattern") result.oldProviderPattern = argv[++i];
    else if (arg === "--provider-group") result.providerGroup = argv[++i];
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function usage() {
  console.log(`
Usage:
  node update-clash-subscriptions.js --base <base.yaml> --out <updated.yaml> --sub <url-or-file> [--sub <url-or-file>]

Options:
  --replace-all                  Replace the whole proxies array with fetched nodes.
  --replace-from-group <name>     Remove old proxies listed in this group before adding fetched nodes.
  --provider-group <name>         Put every fetched node into this provider group. Default: 🍀huaheban

Example:
  node update-clash-subscriptions.js \\
    --base "C:\\Users\\snakedemon\\Downloads\\Telegram Desktop\\stash2 (2).yaml" \\
    --out ".\\stash2.updated.yaml" \\
    --sub "https://example.com/sub?token=xxx" \\
    --replace-from-group "🍀huaheban"
`);
}

async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      redirect: "follow",
      headers: {
        "User-Agent": "Clash.Meta",
        Accept: "*/*",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${source}: ${text.slice(0, 160)}`);
    }
    if (/Attention Required! \| Cloudflare|cf-error-code|cdn-cgi\/challenge/i.test(text)) {
      throw new Error(`Cloudflare blocked this subscription URL: ${source}`);
    }
    return text;
  }

  return fs.readFileSync(source, "utf8");
}

function parseSubscription(content, source) {
  const trimmed = content.trim();

  try {
    const parsed = YAML.parse(trimmed);
    if (Array.isArray(parsed?.proxies)) return parsed.proxies;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to base64 and URI parsing.
  }

  const decoded = maybeBase64Decode(trimmed);
  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const proxies = lines.map(parseProxyUri).filter(Boolean);
  if (proxies.length > 0) return proxies;

  throw new Error(`Unsupported subscription format: ${source}`);
}

function maybeBase64Decode(value) {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) return value;
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return decoded.includes("://") || decoded.includes("proxies:") ? decoded : value;
  } catch {
    return value;
  }
}

function parseProxyUri(line) {
  if (line.startsWith("vmess://")) return parseVmess(line);
  if (line.startsWith("ss://")) return parseShadowsocks(line);
  if (line.startsWith("trojan://")) return parseTrojan(line);
  if (line.startsWith("ssr://")) return parseSsr(line);
  return null;
}

function parseVmess(line) {
  const raw = decodeBase64Body(line.slice("vmess://".length));
  const data = JSON.parse(raw);
  return {
    name: data.ps || data.name || `${data.add}:${data.port}`,
    type: "vmess",
    server: data.add,
    port: Number(data.port),
    uuid: data.id,
    alterId: Number(data.aid || 0),
    cipher: data.scy || "auto",
    tls: data.tls === "tls",
    network: data.net || undefined,
    "ws-opts": data.net === "ws" ? { path: data.path || "/", headers: data.host ? { Host: data.host } : undefined } : undefined,
    servername: data.sni || undefined,
  };
}

function parseShadowsocks(line) {
  const url = new URL(line.replace("ss://", "ss://placeholder@"));
  const hashName = decodeURIComponent(url.hash.replace(/^#/, "")) || url.searchParams.get("remarks");
  const encoded = line.slice("ss://".length).split("#")[0].split("?")[0];
  const decoded = encoded.includes("@") ? encoded : decodeBase64Body(encoded);
  const [userInfo, hostPort] = decoded.split("@");
  const [cipher, password] = userInfo.split(":");
  const [server, port] = hostPort.split(":");
  return {
    name: hashName || `${server}:${port}`,
    type: "ss",
    server,
    port: Number(port),
    cipher,
    password,
  };
}

function parseTrojan(line) {
  const url = new URL(line);
  return {
    name: decodeURIComponent(url.hash.replace(/^#/, "")) || `${url.hostname}:${url.port}`,
    type: "trojan",
    server: url.hostname,
    port: Number(url.port),
    password: decodeURIComponent(url.username),
    sni: url.searchParams.get("sni") || undefined,
    "skip-cert-verify": url.searchParams.get("allowInsecure") === "1" || undefined,
  };
}

function parseSsr(line) {
  const raw = decodeBase64Body(line.slice("ssr://".length));
  const [main, queryString = ""] = raw.split("/?");
  const [server, port, protocol, cipher, obfs, passwordEncoded] = main.split(":");
  const params = new URLSearchParams(queryString);
  return {
    name: decodeBase64Param(params.get("remarks")) || `${server}:${port}`,
    type: "ssr",
    server,
    port: Number(port),
    cipher,
    password: decodeBase64Body(passwordEncoded),
    protocol,
    obfs,
    "protocol-param": decodeBase64Param(params.get("protoparam")) || undefined,
    "obfs-param": decodeBase64Param(params.get("obfsparam")) || undefined,
  };
}

function decodeBase64Body(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeBase64Param(value) {
  if (!value) return "";
  try {
    return decodeBase64Body(value);
  } catch {
    return "";
  }
}

function uniqueByName(proxies) {
  const seen = new Map();
  for (const proxy of proxies) {
    if (!proxy || !proxy.name) continue;
    let name = String(proxy.name);
    if (seen.has(name)) {
      let index = 2;
      while (seen.has(`${name} ${index}`)) index += 1;
      name = `${name} ${index}`;
      proxy.name = name;
    }
    seen.set(name, proxy);
  }
  return [...seen.values()];
}

function normalizeProxyName(proxy) {
  return {
    ...proxy,
    name: String(proxy.name).trim(),
  };
}

function isUsableProxy(proxy) {
  if (!proxy?.name || !proxy.type || !proxy.server || !proxy.port) return false;
  return !/(剩余流量|套餐到期|到期时间|过期时间|官网|续费|流量信息|Traffic|Expire|Renew|官网地址|订阅)/i.test(proxy.name);
}

function mergeProxies(existing, incoming, replaceGroupName, groups) {
  const removeNames = new Set();
  if (replaceGroupName) {
    const group = groups.find((item) => item.name === replaceGroupName);
    for (const name of group?.proxies || []) removeNames.add(name);
  }

  for (const proxy of incoming) removeNames.add(proxy.name);
  const kept = existing.filter((proxy) => proxy?.name && !removeNames.has(proxy.name));
  return [...kept, ...incoming];
}

function replaceProviderProxies(existing, incoming, oldProviderPattern) {
  const pattern = new RegExp(oldProviderPattern, "i");
  const incomingNames = new Set(incoming.map((proxy) => proxy.name));
  return [
    ...existing.filter((proxy) => proxy?.name && !pattern.test(proxy.name) && !incomingNames.has(proxy.name)),
    ...incoming,
  ];
}

function preserveGroupComposition(groups, newNames, oldProviderPattern) {
  const pattern = new RegExp(oldProviderPattern, "i");
  const byRegion = {
    hk: [],
    jp: [],
    kr: [],
    us: [],
    sg: [],
    tw: [],
    th: [],
    other: [],
  };

  for (const name of newNames) {
    byRegion[classify(name)].push(name);
  }

  const allNew = dedupe(newNames);

  for (const group of groups) {
    if (!Array.isArray(group.proxies)) continue;
    let changed = false;
    const next = [];

    for (const name of group.proxies) {
      if (!pattern.test(name)) {
        next.push(name);
        continue;
      }

      changed = true;
      const replacement = byRegion[classify(name)];
      next.push(...(replacement.length ? replacement : allNew));
    }

    if (changed) {
      group.proxies = dedupe(next);
    }
  }
}

function updateGroups(groups, newNames, options) {
  const byRegion = {
    hk: [],
    jp: [],
    kr: [],
    us: [],
    sg: [],
    tw: [],
    th: [],
    other: [],
  };

  for (const name of newNames) {
    const region = classify(name);
    byRegion[region].push(name);
  }

  const allNew = [...newNames];
  replaceGroupProxies(groups, options.providerGroup, allNew);

  for (const groupName of DEFAULT_GROUPS.all) appendGroupProxies(groups, groupName, allNew);
  for (const groupName of DEFAULT_GROUPS.auto) replaceGroupProxies(groups, groupName, allNew);
  for (const groupName of DEFAULT_GROUPS.featured) replaceGroupProxies(groups, groupName, pickFeatured(byRegion, allNew));

  for (const region of ["hk", "jp", "kr", "us", "sg", "tw", "th"]) {
    for (const groupName of DEFAULT_GROUPS[region]) {
      replaceGroupProxies(groups, groupName, byRegion[region]);
    }
  }

  const otherNames = [
    ...byRegion.other,
    ...byRegion.kr,
    ...byRegion.sg,
    ...byRegion.th,
  ];
  for (const groupName of DEFAULT_GROUPS.other) replaceGroupProxies(groups, groupName, otherNames.length ? otherNames : allNew);
}

function classify(name) {
  const lower = name.toLowerCase();
  if (/香港|港|🇭🇰|\bhk\b|hong\s*kong/.test(lower)) return "hk";
  if (/日本|东京|大阪|🇯🇵|\bjp\b|japan|tokyo|osaka/.test(lower)) return "jp";
  if (/韩国|首尔|🇰🇷|\bkr\b|korea|seoul/.test(lower)) return "kr";
  if (/美国|美國|洛杉矶|纽约|西雅图|🇺🇸|\bus\b|usa|united\s*states|america|los\s*angeles|new\s*york|seattle/.test(lower)) return "us";
  if (/新加坡|狮城|🇸🇬|\bsg\b|singapore/.test(lower)) return "sg";
  if (/台湾|台灣|台北|🇹🇼|\btw\b|taiwan|taipei/.test(lower)) return "tw";
  if (/泰国|泰國|曼谷|🇹🇭|\bth\b|thailand|bangkok/.test(lower)) return "th";
  return "other";
}

function pickFeatured(byRegion, allNames) {
  const picked = [];
  for (const region of ["hk", "jp", "tw", "sg", "kr", "us"]) {
    picked.push(...byRegion[region].slice(0, 3));
  }
  return picked.length ? picked : allNames.slice(0, 15);
}

function replaceGroupProxies(groups, groupName, names) {
  const group = groups.find((item) => item.name === groupName);
  if (!group || !Array.isArray(group.proxies)) return;
  group.proxies = names.length ? dedupe(names) : group.proxies;
}

function appendGroupProxies(groups, groupName, names) {
  const group = groups.find((item) => item.name === groupName);
  if (!group || !Array.isArray(group.proxies)) return;
  group.proxies = dedupe([...group.proxies.filter((name) => !names.includes(name)), ...names]);
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
