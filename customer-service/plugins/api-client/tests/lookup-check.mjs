/**
 * api-client 核对式查询（lookup_*）验收脚本。
 *
 * 判据（对应「10086 不会念出你的号码」这条业务约束）：
 *   A. lookup_contract 对某合约号只回该合约的记录，**响应里不存在第二个合约号**；
 *   B. 工具输出里没有合约总数（no_ca）之类的聚合值；
 *   C. 字段白名单生效：上游返回的 name（姓名）等未列入字段不出现；
 *   D. 合约号格式不符时在**发出请求之前**就被拒（不发网络请求）；
 *   E. api_get 无法访问 /api/contract/all/（路径白名单已移除该前缀）；
 *   F. 查不到的合约号返回 found=false，且不抛错、不泄漏其它记录；
 *   G. 组合层：preset 里 apiPathAllowlist 不含 contract/all，且 apiLookup 已配置。
 *
 * 运行：node --import tsx/esm customer-service/plugins/api-client/tests/lookup-check.mjs
 * 断言失败必须非零退出。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')
const PRESET = join(REPO, 'customer-service/presets/customer-service-guest/agent.cordis.yml')

let passed = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}
const section = title => console.log(`\n${title}`)

// ── 被测插件的 apply：用假的 tools 注册表捕获工具定义 ──────────────────────
const { apply, Config } = await import('../src/index.ts')

const config = Config({
  vaultRoot: '/kb',
  apiAllowlist: ['https://api.test/'],
  apiPathAllowlist: ['/api/bill/'],
  apiLookupFields: {
    contract: ['ca_no', 'tariff_class', 'amount', 'paid'],
    bill: ['contractAccountNo', 'dueAmount'],
  },
  apiLookup: [
    {
      name: 'contract',
      description: '核对合约号',
      pathTemplate: '/api/contract/all/ai/{lang}',
      fixedQuery: {},
      keyedBy: 'contract_no',
      valuePattern: '[0-9]{10}',
      valueHint: '10 位数字的合约号',
      listPath: 'data.caInfo',
      matchField: 'ca_no',
    },
    {
      name: 'bill',
      description: '取回账单',
      pathTemplate: '/api/bill/{contract_no}/ai/{lang}',
      fixedQuery: { level: '1' },
      keyedBy: 'contract_no',
      valuePattern: '[0-9]{10}',
      valueHint: '10 位数字的合约号',
      listPath: 'data.billInfo',
      matchField: 'contractAccountNo',
    },
  ],
})

const tools = new Map()
apply({ tools: { register: t => { tools.set(t.name, t) } } }, config)

// 上游响应：一份含 3 个合约的清单（其中一个是目标），字段里带姓名等敏感列。
const CONTRACT_PAYLOAD = {
  isSuccess: true,
  data: {
    no_ca: '3',
    caInfo: [
      { ca_no: '0070878510', name: '羅*安', tariff_class: 'A1', amount: '200', paid: '已繳費', ca_lang: '中文' },
      { ca_no: '0120618753', name: 'CHAN TAI MAN', tariff_class: 'A1', amount: '60', paid: '已繳費', ca_lang: '英文' },
      { ca_no: '0122631315', name: 'LEE SIU YUK', tariff_class: 'B3', amount: '650', paid: '已繳費', ca_lang: '中文' },
    ],
  },
}

const originalFetch = globalThis.fetch
let fetchCalls = []
const stubFetch = payload => async (url, init) => {
  fetchCalls.push(String(url))
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    headers: new Headers({ 'content-type': 'application/json' }),
  }
}

const resetFetch = payload => { fetchCalls = []; globalThis.fetch = stubFetch(payload) }

// ── A/B/C：核对一个合约号 ───────────────────────────────────────────────────
section('A/B/C. lookup_contract 只回一个合约，且字段受限')
resetFetch(CONTRACT_PAYLOAD)
const contractTool = tools.get('lookup_contract')
ok('注册了 lookup_contract 工具', contractTool !== undefined)
const res = await contractTool.execute({ contract_no: '0070878510', lang: 'zh' }, { signal: undefined })
const serialized = JSON.stringify(res)
ok('found=true', res.found === true, serialized.slice(0, 120))
ok('回传的是目标合约', res.record?.ca_no === '0070878510', serialized.slice(0, 120))
ok('未泄漏其它合约号 0120618753', !serialized.includes('0120618753'))
ok('未泄漏其它合约号 0122631315', !serialized.includes('0122631315'))
ok('未泄漏合约总数 no_ca=3', !serialized.includes('no_ca') && !/"3"/.test(serialized))
ok('未泄漏姓名字段 name', !serialized.includes('羅*安') && !serialized.includes('CHAN TAI MAN'))
ok('未泄漏未列入白名单的 ca_lang', !serialized.includes('ca_lang') && !serialized.includes('中文'))
ok('保留白名单内字段 tariff_class/amount/paid',
  res.record?.tariff_class === 'A1' && res.record?.amount === '200' && res.record?.paid === '已繳費')
ok('请求打到上游合约端点（由插件自己拼，模型无法改路径）',
  fetchCalls.length === 1 && fetchCalls[0].includes('/api/contract/all/ai/zh'), fetchCalls.join(','))

// ── D：格式校验在网络请求之前 ───────────────────────────────────────────────
section('D. 合约号格式不符：发出请求前就被拒')
resetFetch(CONTRACT_PAYLOAD)
let threw = ''
try { await contractTool.execute({ contract_no: 'abc', lang: 'zh' }, { signal: undefined }) } catch (error) { threw = String(error.message) }
ok('非 10 位数字被拒', threw.includes('10 位数字的合约号'), threw)
ok('未发出任何网络请求', fetchCalls.length === 0, `fetch 调用 ${fetchCalls.length} 次`)

resetFetch(CONTRACT_PAYLOAD)
threw = ''
try { await contractTool.execute({ contract_no: '../../etc/passwd', lang: 'zh' }, { signal: undefined }) } catch (error) { threw = String(error.message) }
ok('路径穿越被拒', threw !== '' && fetchCalls.length === 0, threw)

resetFetch(CONTRACT_PAYLOAD)
threw = ''
try { await contractTool.execute({ contract_no: '0070878510', lang: '../../../etc' }, { signal: undefined }) } catch (error) { threw = String(error.message) }
ok('非法 lang 被拒（不会变成第二段路径）', threw.includes('lang must be one of'), threw)
ok('非法 lang 未发出网络请求', fetchCalls.length === 0, `fetch ${fetchCalls.length} 次`)

// ── E：api_get 到不了合约清单 ───────────────────────────────────────────────
section('E. api_get 无法访问 /api/contract/all/')
resetFetch(CONTRACT_PAYLOAD)
const apiGet = tools.get('api_get')
threw = ''
try { await apiGet.execute({ url: 'https://api.test/api/contract/all/ai/zh' }, { signal: undefined }) } catch (error) { threw = String(error.message) }
ok('api_get 被路径白名单拒绝', threw.includes('path not allowed'), threw)
ok('被拒时未发出网络请求', fetchCalls.length === 0)
// 对照：账单路径仍可用（白名单没把 api_get 一起废掉）
resetFetch({ isSuccess: true, data: { billInfo: [{ contractAccountNo: '0070878510', dueAmount: '30.00' }] } })
const billViaApiGet = await apiGet.execute({ url: 'https://api.test/api/bill/0070878510/ai/zh' }, { signal: undefined })
ok('账单路径仍可被 api_get 访问（对照）', billViaApiGet?.isSuccess === true, JSON.stringify(billViaApiGet).slice(0, 100))

// ── F：查不到 ───────────────────────────────────────────────────────────────
section('F. 查不到该合约号')
resetFetch(CONTRACT_PAYLOAD)
const miss = await contractTool.execute({ contract_no: '9999999999', lang: 'zh' }, { signal: undefined })
ok('found=false', miss.found === false, JSON.stringify(miss))
ok('不回传任何记录', miss.record === undefined)
ok('不回传总数或其它合约', !JSON.stringify(miss).includes('0070878510'))

// ── G：组合层配置 ───────────────────────────────────────────────────────────
section('G. preset 组合层配置')
const yml = readFileSync(PRESET, 'utf8')
// 只取该键下的列表项（渲染成 "      - /xxx" 的行），不要被紧随其后的注释干扰：
// 注释里会提到 contract/all 来解释为什么它被排除，那是说明而非配置。
const pathListLines = (yml.split('apiPathAllowlist:')[1] ?? '')
  .split('\n')
  .filter(line => /^\s*-\s+\S/.test(line))
  .map(line => line.trim())
ok('apiPathAllowlist 不含 contract/all', !pathListLines.some(l => l.includes('contract/all')), pathListLines.join(' '))
ok('apiPathAllowlist 仍含 /api/bill/', pathListLines.some(l => l.includes('/api/bill/')), pathListLines.join(' '))
ok('配置了 apiLookup', yml.includes('apiLookup:') && yml.includes('name: contract'))
ok('lookup 的 keyedBy 是 contract_no', yml.includes('keyedBy: contract_no'))
ok('keyedBy 有格式约束', yml.includes("valuePattern: '[0-9]{10}'"))
ok('字段白名单不含 name', !/^\s+-\s+name$/m.test(yml.split('apiLookupFields:')[1]?.split('apiLookup:')[0] ?? ''))
ok('提示词要求先问合约号', yml.includes('第一步永遠是問合約號'))
ok('提示词禁止报出总数', yml.includes('您名下共有 N 張合約'))

globalThis.fetch = originalFetch

console.log(`\n${passed}/${passed + failed} 项断言通过`)
if (failed > 0) { console.log(`${failed} 项失败`); process.exit(1) }
