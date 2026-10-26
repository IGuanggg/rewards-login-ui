// Domestic topic sources inspired by chiihero/Microsoft-Rewards-Script.
// This adapter keeps the pinned upstream engine and its log protocol intact.
export const LOCAL_TOPICS = ('春季花卉养护,家常菜做法,中国传统节日,周末徒步路线,太阳系行星,古诗词赏析,家庭收纳方法,城市公共交通,中国地理知识,传统建筑风格,博物馆展览,早餐营养搭配,摄影构图技巧,书法入门,中国茶文化,世界自然遗产,手机电池保养,智能家居应用,空气质量知识,二十四节气,办公室拉伸,防灾应急常识,阅读习惯培养,传统乐器介绍,汉字起源,家用电器节能,垃圾分类指南,海洋生物知识,中国航天发展,公共图书馆服务,运动前热身,家庭烘焙,历史人物传记,高铁旅行准备,园林植物识别,新能源汽车知识,保护视力方法,中国地方戏曲,饮水健康知识,天文观测入门,地方特色美食,数学趣味问题,编程基础知识,中国古代发明,数字摄影基础,世界著名河流,家庭急救知识,春夏衣物整理,自然科学实验,传统手工艺,登山装备选择,如何制作读书笔记,电影配乐赏析,家庭网络设置,天气预报原理,城市骑行路线,非物质文化遗产,中国山川地貌,生活中的物理,四季星空变化').split(',')
const SOURCES = ['BaiduHot', 'TouTiaoHot']
let cached, cacheUntil = 0
export function hotWords(data) {
    const list = Array.isArray(data) ? data : data?.data?.list ?? data?.data ?? data?.list ?? []
    if (!Array.isArray(list)) return []
    return [...new Set(list.map(item => typeof item === 'string' ? item : item?.title ?? item?.word ?? item?.name ?? item?.query ?? '')
        .filter(word => typeof word === 'string').map(word => word.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(word => word.length > 1 && word.length <= 100))].slice(0, 100)
}
export async function chinaTopics({ offline = false, fetcher = fetch, report = () => {}, now = Date.now() } = {}) {
    if (offline) { report('使用中文本地词库'); return [...LOCAL_TOPICS] }
    if (cached && now < cacheUntil) { report('使用本轮缓存的国内热词'); return [...cached] }
    for (const source of SOURCES) {
        report(`正在获取国内热词（${source}，最多等待 8 秒）`)
        try {
            const response = await fetcher(`https://api.gmya.net/Api/${source}`, { signal: AbortSignal.timeout(8000), redirect: 'error' })
            if (response.status === 403 || response.status === 429) { report('热词接口限流，自动切换中文本地词库'); break }
            if (!response.ok) throw new Error('source unavailable')
            const reader = response.body.getReader()
            let size = 0, chunks = []
            try {
                while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 262144) throw new Error('response too large'); chunks.push(value) }
            } finally { await reader.cancel().catch(() => {}) }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (['403', '429'].includes(String(body?.code))) { report('热词接口限流，自动切换中文本地词库'); break }
            const words = hotWords(body)
            if (!words.length) throw new Error('empty source')
            cached = [...new Set([...words, ...LOCAL_TOPICS])]; cacheUntil = now + 30 * 60000
            report(`已取得 ${words.length} 条国内热词，中文本地词库作为补充`)
            return [...cached]
        } catch { report(`${source} 不可用，尝试备用词源`) }
    }
    cached = [...LOCAL_TOPICS]; cacheUntil = now + 5 * 60000
    report('国内热词暂不可用，已使用中文本地词库继续运行')
    return [...cached]
}
