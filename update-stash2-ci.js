#!/usr/bin/env node
/*
 * CI-friendly variant of update-stash2-preserve-groups.js
 *
 * Same node-replacement + group-preservation logic as the local script, but all
 * paths and sources are configurable via environment variables so it can run in
 * GitHub Actions (Linux runner) without the hard-coded Windows paths.
 *
 * Required env:
 *   CLASHPERSONAL_TOKEN  - GitHub PAT with read+write access to clashpersonal repo
 * Optional env (sensible defaults provided):
 *   BASE_URL             - where to download the current stash2.yaml (base config)
 *                          Default: https://raw.githubusercontent.com/snakedemon9/clashpersonal/main/stash2.yaml
 *                          May be private, so the token is sent as a Bearer header.
 *   OUT                  - output path for the generated profile.
 *                          Default: ./stash2.updated.yaml (git-ignored)
 *   HUAHE_SOURCE         - path to huahe SSR nodes file. Default: ./huahe-nodes.txt
 *   VV_SUB               - vv subscription URL.
 *   NOVAS_SUB            - novas subscription URL.
 *
 * The generated file is written to OUT. The caller (GitHub Actions workflow) is
 * responsible for pushing OUT to the clashpersonal repo as stash2.yaml.
 */
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const BASE_URL = process.env.BASE_URL ||
  "https://raw.githubusercontent.com/snakedemon9/clashpersonal/main/stash2.yaml";
const OUT = process.env.OUT || path.join(__dirname, "stash2.updated.yaml");
const HUAHE_SOURCE = process.env.HUAHE_SOURCE || path.join(__dirname, "huahe-nodes.txt");
const VV_SUB = process.env.VV_SUB || "https://s.vvud.us/s/301a9b543fcb14fb6cfebad2b9a521f7";
const NOVAS_SUB = process.env.NOVAS_SUB || "https://re.ed-novas.com/2cvme3wa8i/c07efb90a2bf71816296719aea254bda?router=1";
const TOKEN = process.env.CLASHPERSONAL_TOKEN || "";

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  if (!TOKEN) {
    console.warn("Warning: CLASHPERSONAL_TOKEN is not set. If BASE_URL is private, the download will fail.");
  }

  const baseText = await readRemoteBase(BASE_URL);
  const doc = YAML.parseDocument(baseText, { keepSourceTokens: true });
  const config = doc.toJS();

  if (!Array.isArray(config.proxies)) {
    throw new Error("Base config does not contain a proxies array.");
  }
  if (!Array.isArray(config["proxy-groups"])) {
    throw new Error("Base config does not contain a proxy-groups array.");
  }

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
  replaceGroupByNameFragment(config["proxy-groups"], "泰国节点", novasOtherCountryNodes.filter((node) => classify(node.name) === "th").map((node) => node.name));
  removeNonChinaHuaheFromReturnGroup(config["proxy-groups"], huaheNodes);
  removeProxiesByName(config, /网际快车/);
  removeProxyGroupsByName(config, /网际快车/);
  rebuildRegionGroups(config);
  ensureNoEmptyProxyGroups(config["proxy-groups"]);

  doc.set("proxies", config.proxies);
  doc.set("proxy-groups", config["proxy-groups"]);

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const output = String(doc);
  fs.writeFileSync(OUT, output, "utf8");

  console.log(`Wrote ${OUT}`);
  console.log(`huahe nodes: ${huaheNodes.length}`);
  console.log(`vv nodes: ${vvNodes.length}`);
  console.log(`novas return nodes: ${novasReturnNodes.length}`);
  console.log(`novas other-country nodes: ${novasOtherCountryNodes.length}`);
  console.log(`old huahe nodes replaced: ${oldHuaheNames.size}`);
  console.log(`old vv nodes replaced: ${oldVvNames.size}`);
  console.log(`old novas nodes replaced: ${oldNovasNames.size}`);
  console.log(`proxies total: ${config.proxies.length}`);
  console.log(`proxy-groups total: ${config["proxy-groups"].length}`);

  // Fail loudly if the replacement produced an obviously broken config:
  // every non-REJECT group must reference at least one real node or sub-group.
  const dangling = countDanglingRefs(config);
  if (dangling > 0) {
    throw new Error(`Validation failed: ${dangling} dangling group references after update. Aborting to avoid pushing a broken profile.`);
  }
}

// Read the base stash2.yaml over HTTP, sending the token so private repos work.
// Falls back to an unauthenticated request if no token (public repo case).
async function readRemoteBase(url) {
  const headers = { "User-Agent": "clash-updater-ci", Accept: "*/*" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(url, { redirect: "follow", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching base config: ${url}\n${text.slice(0, 200)}`);
  }
  return text;
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

// Rebuild every region-specific group so it reliably contains ALL nodes that
// belong to that region (huahe + 专线 + novas-overseas + anything else), instead
// of relying on stale name carry-over. A group counts as region-specific when
// classify() maps its NAME to a concrete region (hk/jp/kr/us/sg/tw/th).
//
// For each such group: keep its type/url/interval etc., but replace its proxies
// list with the names of every defined proxy whose name classifies to the same
// region. Non-region groups (e.g. 🤖 ChatGPT, ♻️ 自动选择) are left untouched.
// Sub-group references and built-ins (DIRECT/REJECT) inside a region group are
// dropped, because a region group should list concrete nodes.
function rebuildRegionGroups(config) {
  const REGION_CODES = new Set(["hk", "jp", "kr", "us", "sg", "tw", "th"]);

  // Bucket every defined proxy by the region inferred from its NAME.
  const byRegion = new Map();
  for (const region of REGION_CODES) byRegion.set(region, []);
  for (const proxy of config.proxies) {
    const name = proxy?.name;
    if (!name) continue;
    const region = classify(name);
    if (REGION_CODES.has(region)) byRegion.get(region).push(name);
  }

  for (const group of config["proxy-groups"]) {
    const region = classify(group.name);
    if (!REGION_CODES.has(region)) continue;          // not a region group
    if (!Array.isArray(group.proxies)) continue;

    const members = dedupe(byRegion.get(region));
    if (members.length === 0) continue;                // leave as-is if no nodes

    // Preserve a stable, readable order: keep the group's existing entries that
    // are still valid regional members first, then append any newly added ones.
    const ordered = [];
    const seen = new Set();
    for (const name of group.proxies) {
      if (members.includes(name) && !seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    for (const name of members) {
      if (!seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    // Entries that no longer classify to this region are simply not carried over.
    group.proxies = ordered;
  }
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

// Validation: count group entries that reference neither a defined proxy, nor a
// defined group, nor a built-in. The original script left this to the human; in
// CI we fail loudly so a broken profile is never auto-pushed.
function countDanglingRefs(config) {
  const proxyNames = new Set(config.proxies.map((p) => p?.name).filter(Boolean));
  const groupNames = new Set(config["proxy-groups"].map((g) => g?.name).filter(Boolean));
  const builtins = new Set(["DIRECT", "REJECT", "PASS", "GLOBAL", "COMPATIBLE"]);

  let dangling = 0;
  for (const group of config["proxy-groups"]) {
    if (!Array.isArray(group.proxies)) continue;
    for (const name of group.proxies) {
      if (typeof name !== "string") {
        dangling += 1;
        continue;
      }
      if (proxyNames.has(name) || groupNames.has(name) || builtins.has(name)) continue;
      dangling += 1;
    }
  }
  return dangling;
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
