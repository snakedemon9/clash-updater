const unique = values => [...new Set(values)];

function optimizeGroups(config, huahe, vv) {
  const renames = new Map();
  const used = new Set(config.proxies.filter(p => !vv.includes(p)).map(p => p.name));
  for (const node of vv) {
    const original = node.name;
    const rate = original.match(/(\d+(?:\.\d+)?)\s*(?:倍率|倍|[xX])/);
    const country = original.match(/香港|日本|韩国|美国|新加坡|台湾|加拿大|泰国|英国|德国|法国|越南|马来西亚|土耳其|澳大利亚|俄罗斯|印度/);
    const line = original.match(/(?:专线|线路)([A-Za-z]*\d+)/);
    const number = country && original.slice(country.index + country[0].length).match(/^\s*([0-9]+[a-z]?)/i);
    const features = ['AI', 'Claude', '家宽', '静态', '双ISP', '直连'].filter(word => original.toLowerCase().includes(word.toLowerCase()));
    const base = ['VV', rate ? rate[1] + 'x' : '', country ? country[0] + (number ? number[1] : '') : original.slice(0, 18), line ? line[1] : '', ...features].filter(Boolean).join(' ');
    let name = base, index = 2;
    while (used.has(name)) name = base + ' #' + index++;
    used.add(name);
    renames.set(original, name);
    node.name = name;
  }
  for (const group of config['proxy-groups']) {
    group.proxies = unique((group.proxies || []).map(name => renames.get(name) || name));
  }
  const provider = config['proxy-groups'].find(g => g.name === 'vv');
  if (provider) provider.proxies = vv.map(p => p.name);
  const huaheNames = new Set(huahe.map(p => p.name));
  const direct = new Set(huahe.filter(p => /直连|direct/i.test(p.name)).map(p => p.name));
  for (const group of config['proxy-groups']) {
    if (group.type === 'select' && group.name !== 'vv' && !/回国|novas|香港|日本|韩国|美国|新加坡|台湾|泰国/.test(group.name)) {
      const hasPolicies = group.proxies.some(name => config['proxy-groups'].some(g => g.name === name));
      if (hasPolicies || /手动/.test(group.name)) group.proxies = unique([...group.proxies, 'vv']);
    }
    if (group.type === 'url-test') group.proxies = group.proxies.filter(name => !direct.has(name));
    if (/回国/.test(group.name)) group.proxies = group.proxies.filter(name => !huaheNames.has(name));
  }
}

module.exports = optimizeGroups;
