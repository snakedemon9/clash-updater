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
    group.proxies = group.proxies.filter(name => !huaheNames.has(name));
  }
  const isolated = [
    { name: 'Huahe选择', type: 'select', proxies: huahe.map(p => p.name) },
    { name: 'Huahe测速', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: huahe.filter(p => !direct.has(p.name)).map(p => p.name) },
  ];
  for (const definition of isolated) {
    const index = config['proxy-groups'].findIndex(g => g.name === definition.name);
    if (index < 0) config['proxy-groups'].push(definition);
    else config['proxy-groups'][index] = definition;
  }
  // Provider groups are selectable on demand, never included in shared speed tests.
  for (const group of config['proxy-groups']) {
    if (group.type === 'select' && /手动选择|手动切换|全局设置/.test(group.name)) {
      group.proxies = unique([...group.proxies, ...isolated.map(g => g.name)]);
    }
  }
  const groups = config['proxy-groups'];
  const groupNames = new Set(groups.map(g => g.name));
  const endpoints = groups.filter(g => !g.proxies.some(n => groupNames.has(n)) && !/广告拦截|应用净化|battle\.net/.test(g.name));
  const endpointNames = endpoints.map(g => g.name);
  const manual = groups.find(g => /手动选择|手动切换/.test(g.name));
  if (manual) manual.proxies = unique([...manual.proxies, ...endpointNames]);
  for (const group of groups) {
    if (group.type !== 'select' || endpoints.includes(group)) continue;
    group.proxies = unique([...group.proxies, ...endpointNames.filter(n => n !== group.name)]);
    if (manual && group !== manual && !/广告拦截|应用净化/.test(group.name)) {
      group.proxies = unique([...group.proxies, manual.name]);
    }
  }
}

module.exports = optimizeGroups;
