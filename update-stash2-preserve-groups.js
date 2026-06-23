#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const BASE = "C:/Users/snakedemon/Downloads/Telegram Desktop/stash2 (2).yaml";
const OUT = "C:/Users/snakedemon/Documents/Codex/2026-05-08/clash/stash2.updated.preserve-groups.yaml";
const GITHUB_STASH2 = "C:/Users/snakedemon/Documents/Codex/2026-05-08/clashpersonal/stash2.yaml";
const HUAHE_SOURCE = "C:/Users/snakedemon/Documents/Codex/2026-05-08/clash/huahe-nodes.txt";
const VV_SUB = "https://s.vvud.us/s/301a9b543fcb14fb6cfebad2b9a521f7";
const NOVAS_SUB = "https://re.ed-novas.com/2cvme3wa8i/c07efb90a2bf71816296719aea254bda?router=1";

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const baseText = fs.readFileSync(BASE, "utf8");
  const doc = YAML.parseDocument(baseText, { keepSourceTokens: true });
  const config = doc.toJS();

  const huaheNodes = await loadNodes(HUAHE_SOURCE);
  const vvNodes = await loadNodes(VV_SUB);
  const allNovasNodes = await loadNodes(NOVAS_SUB);
  const novasReturnNodes = allNovasNodes.filter((node) => isReturnHome(node.name));
  const novasOtherCountryNodes = allNovasNodes.filter((node) => isNovasOtherCountry(node.name));
  const novasNodes = [...novasReturnNodes, ...novasOtherCountryNodes];

  const oldHuaheProxies = config.proxies.filter(
    (proxy) => proxy.type === "ssr" && /(huaqiduo|yuyuhuaa|polgade)/i.test(String(proxy.server)),
  );
  alignNamesByEndpoint(huaheNodes, oldHuaheProxies);
  const oldHuaheNames = new Set(oldHuaheProxies.map((proxy) => proxy.name));
  const oldVvNames = new Set(config.proxies.filter((proxy) => /^vv/i.test(proxy.name)).map((proxy) => proxy.name));
  const oldNovasNames = new Set(
    config.proxies
      .filter((proxy) => /ednovas/i.test(String(proxy.server)))
      .map((proxy) => proxy.name),
  );

  const huaheNames = new Set(huaheNodes.map((proxy) => proxy.name));
  const vvNames = new Set(vvNodes.map((proxy) => proxy.name));
  const novasNames = new Set(novasNodes.map((proxy) => proxy.name));

  config.proxies = [
    ...config.proxies.filter(
      (proxy) =>
        proxy?.name &&
        !oldHuaheNames.has(proxy.name) &&
        !oldVvNames.has(proxy.name) &&
        !oldNovasNames.has(proxy.name) &&
        !huaheNames.has(proxy.name) &&
        !vvNames.has(proxy.name) &&
        !novasNames.has(proxy.name),
    ),
    ...huaheNodes,
    ...vvNodes,
    ...novasNodes,
  ];

  for (const group of config["proxy-groups"]) {
    if (!Array.isArray(group.proxies)) continue;
    const next = [];

    for (const name of group.proxies) {
      if (oldHuaheNames.has(name)) {
        next.push(...nodesForOldName(huaheNodes, name, "huahe"));
      } else if (oldVvNames.has(name)) {
        next.push(...nodesForOldName(vvNodes, name, "vv"));
      } else if (oldNovasNames.has(name)) {
        next.push(...nodesForOldName(novasReturnNodes, name, "novas"));
      } else {
        next.push(name);
      }
    }

    group.proxies = dedupe(next);
  }

  upsertGroup(config["proxy-groups"], {
    name: "novas",
    type: "select",
    proxies: novasReturnNodes.map((proxy) => proxy.name),
  });
  upsertGroup(config["proxy-groups"], {
    name: "novas其他国家",
    type: "select",
    proxies: novasOtherCountryNodes.map((proxy) => proxy.name),
  });
  replaceGroupByNameFragment(config["proxy-groups"], "\u6cf0\u56fd\u8282\u70b9", novasOtherCountryNodes.filter((node) => classify(node.name) === "th").map((node) => node.name));
  removeNonChinaHuaheFromReturnGroup(config["proxy-groups"], huaheNodes);
  removeProxiesByName(config, /网际快车/);
  removeProxyGroupsByName(config, /网际快车/);
  ensureNoEmptyProxyGroups(config["proxy-groups"]);

  doc.set("proxies", config.proxies);
  doc.set("proxy-groups", config["proxy-groups"]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const output = String(doc);
  fs.writeFileSync(OUT, output, "utf8");
  if (fs.existsSync(path.dirname(GITHUB_STASH2))) {
    fs.writeFileSync(GITHUB_STASH2, output, "utf8");
  }

  console.log(`Wrote ${OUT}`);
  if (fs.existsSync(GITHUB_STASH2)) console.log(`Wrote ${GITHUB_STASH2}`);
  console.log(`huahe nodes: ${huaheNodes.length}`);
  console.log(`vv nodes: ${vvNodes.length}`);
  console.log(`novas return nodes: ${novasReturnNodes.length}`);
  console.log(`novas other-country nodes: ${novasOtherCountryNodes.length}`);
  console.log(`old huahe nodes replaced: ${oldHuaheNames.size}`);
  console.log(`old vv nodes replaced: ${oldVvNames.size}`);
  console.log(`old novas nodes replaced: ${oldNovasNames.size}`);
}

async function loadNodes(source) {
  const text = await readSource(source);
  const proxies = parseSubscription(text, source);
  return uniqueByName(proxies.map(normalizeProxy).filter(isUsableProxy));
}

async function readSource(source) {
  if (!/^https?:\/\//i.test(source)) {
    return fs.readFileSync(source, "utf8");
  }

  const response = await fetch(source, {
    redirect: "follow",
    headers: {
      "User-Agent": "Clash.Meta",
      Accept: "*/*",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${source}`);
  return text;
}

function parseSubscription(text, source) {
  const trimmed = maybeBase64(text.trim());
  try {
    const parsed = YAML.parse(trimmed);
    if (Array.isArray(parsed?.proxies)) return parsed.proxies;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to URI line parsing.
  }

  const proxies = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseProxyUri)
    .filter(Boolean);

  if (proxies.length === 0) throw new Error(`No proxies parsed from ${source}`);
  return proxies;
}

function maybeBase64(text) {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) return text;
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return decoded.includes("proxies:") ? decoded : text;
  } catch {
    return text;
  }
}

function parseProxyUri(line) {
  if (line.startsWith("ssr://")) return parseSsr(line);
  return null;
}

function parseSsr(line) {
  const raw = decodeBase64Body(line.slice("ssr://".length));
  const [main, queryString = ""] = raw.split("/?");
  const [server, port, protocol, cipher, obfs, passwordEncoded] = main.split(":");
  const params = new URLSearchParams(queryString);
  return {
    name: decodeBase64Param(params.get("remarks")) || `${server}:${port}`,
    server,
    port: Number(port),
    type: "ssr",
    cipher,
    password: decodeBase64Body(passwordEncoded),
    protocol,
    obfs,
    "protocol-param": decodeBase64Param(params.get("protoparam")) || undefined,
    "obfs-param": decodeBase64Param(params.get("obfsparam")) || undefined,
    "client-fingerprint": "chrome",
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

function normalizeProxy(proxy) {
  return {
    ...proxy,
    name: String(proxy.name || "").trim(),
  };
}

function isUsableProxy(proxy) {
  if (!proxy?.name || !proxy.type || !proxy.server || !proxy.port) return false;
  if (!isStashSupportedProxyType(proxy.type)) return false;
  return !/(剩余流量|套餐到期|到期时间|过期时间|官网|续费|流量信息|使用时|全局模式|Global|Traffic|Expire|Renew|官网地址|订阅|User Group|User Guide|EdNovas Cloud)/i.test(proxy.name);
}

function isStashSupportedProxyType(type) {
  return new Set(["ss", "ssr", "vmess", "trojan", "vless", "hysteria", "hysteria2"]).has(String(type).toLowerCase());
}

function uniqueByName(proxies) {
  const seen = new Map();
  for (const proxy of proxies) {
    let name = proxy.name;
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

function nodesForOldName(nodes, oldName, provider) {
  if (provider === "huahe") {
    return [oldName];
  }

  if (provider === "novas") {
    return isReturnHome(oldName) ? nodes.map((node) => node.name) : [];
  }

  const region = classify(oldName);
  const matched = nodes.filter((node) => classify(node.name) === region).map((node) => node.name);
  return matched.length ? matched : nodes.map((node) => node.name);
}

function isNovasOtherCountry(name) {
  if (isReturnHome(name)) return false;
  return !new Set(["hk", "jp", "us", "kr"]).has(classify(name));
}

function classify(name) {
  const text = String(name).toLowerCase();
  if (/香港|🇭🇰|\bhk\b|hong\s*kong/.test(text)) return "hk";
  if (/日本|🇯🇵|\bjp\b|japan|tokyo|osaka/.test(text)) return "jp";
  if (/韩国|韓國|🇰🇷|\bkr\b|korea|seoul/.test(text)) return "kr";
  if (/美国|美國|🇺🇸|\bus\b|usa|america|united\s*states|los\s*angeles|houston/.test(text)) return "us";
  if (/新加坡|🇸🇬|\bsg\b|singapore/.test(text)) return "sg";
  if (/台湾|台灣|🇹🇼|\btw\b|taiwan/.test(text)) return "tw";
  if (/泰国|泰國|🇹🇭|\bth\b|thailand|bangkok/.test(text)) return "th";
  if (/加拿大|🇨🇦|canada|toronto|ottawa/.test(text)) return "ca";
  if (/墨西哥|🇲🇽|mexico/.test(text)) return "mx";
  if (/越南|vietnam/.test(text)) return "vn";
  if (/马来|馬來|🇲🇾|malaysia/.test(text)) return "my";
  if (/土耳其|turkey/.test(text)) return "tr";
  return "other";
}

function isReturnHome(name) {
  return /日志记录|🇨🇳|宁波|绍兴|湖北|厦门|泉州|广州|济南|上海|深圳|福州|长沙|杭州|南京|北京|回国|中转/.test(String(name));
}

function upsertGroup(groups, group) {
  const index = groups.findIndex((item) => item.name === group.name);
  if (index >= 0) {
    groups[index] = { ...groups[index], ...group };
    return;
  }

  const returnGroupIndex = groups.findIndex((item) => String(item.name).includes("回国节点"));
  groups.splice(returnGroupIndex >= 0 ? returnGroupIndex + 1 : groups.length, 0, group);
}

function removeNonChinaHuaheFromReturnGroup(groups, huaheNodes) {
  const huaheNames = new Set(huaheNodes.map((node) => node.name));
  const group = groups.find((item) => String(item.name).includes("回国节点"));
  if (!group || !Array.isArray(group.proxies)) return;

  group.proxies = group.proxies.filter((name) => {
    if (!huaheNames.has(name)) return true;
    return !/非大陆专用/.test(String(name));
  });
}

function removeProxiesByName(config, pattern) {
  const removed = new Set(
    config.proxies
      .filter((proxy) => proxy?.name && pattern.test(String(proxy.name)))
      .map((proxy) => proxy.name),
  );

  if (removed.size === 0) return;

  config.proxies = config.proxies.filter((proxy) => !removed.has(proxy.name));

  for (const group of config["proxy-groups"]) {
    if (!Array.isArray(group.proxies)) continue;
    group.proxies = group.proxies.filter((name) => !removed.has(name));
  }
}

function removeProxyGroupsByName(config, pattern) {
  const removed = new Set(
    config["proxy-groups"]
      .filter((group) => group?.name && pattern.test(String(group.name)))
      .map((group) => group.name),
  );

  if (removed.size === 0) return;

  config["proxy-groups"] = config["proxy-groups"].filter((group) => !removed.has(group.name));

  for (const group of config["proxy-groups"]) {
    if (!Array.isArray(group.proxies)) continue;
    group.proxies = group.proxies.filter((name) => !removed.has(name));
  }
}

function replaceGroupByNameFragment(groups, fragment, proxies) {
  const group = groups.find((item) => String(item.name).includes(fragment));
  if (!group || !Array.isArray(group.proxies) || proxies.length === 0) return;
  group.proxies = dedupe(proxies);
}

function ensureNoEmptyProxyGroups(groups) {
  for (const group of groups) {
    if (!Array.isArray(group.proxies)) continue;
    group.proxies = dedupe(group.proxies);
    if (group.proxies.length === 0) {
      group.proxies = ["DIRECT"];
    }
  }
}

function alignNamesByEndpoint(newNodes, oldNodes) {
  const oldByEndpoint = new Map();
  for (const node of oldNodes) {
    const key = endpointKey(node);
    const bucket = oldByEndpoint.get(key) || [];
    bucket.push(node.name);
    oldByEndpoint.set(key, bucket);
  }

  for (const node of newNodes) {
    const bucket = oldByEndpoint.get(endpointKey(node));
    if (bucket?.length) {
      node.name = bucket.shift();
    }
  }
}

function endpointKey(node) {
  return `${node.server}:${node.port}`;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
