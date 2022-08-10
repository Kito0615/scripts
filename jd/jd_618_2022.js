/*
* 2022 京东618 活动（一起分19亿）
* Kito0615(https://github.com/Kito0615)
* v 0.1 2022.05.24
*/
const $ = new Env('分19亿');
const notify = $.isNode() ? require('./sendNotify') : '';
let cookiesArr = [], cookie = '', message, helpCodeArr = [], helpPinArr = [], wxCookie = "";
let wxCookieArr = process.env.WXCookie?.split("@") || []
const teamLeaderArr = [], teamPlayerAutoTeam = {}
const jdCookieNode = $.isNode() ? require('./jdCookie.js') : '';
const appid = $.appid = "50089"
$.curlCmd = ""
const h = (new Date()).getHours()
const helpFlag = h >= 9 && h < 12
const puzzleFlag = h >= 13 && h < 18
if ($.isNode()) {
	Object.keys(jdCookieNode).forEach((item) => {
		cookiesArr.push(jdCookieNode[item])
	})
	if (process.env.JD_DEBUG && process.env.JD_DEBUG === 'false') console.log = () => {};
} else {
	cookiesArr = [$.getdata('CookieJD'), $.getdata('CookieJD2'), ...jsonParse($.getdata('CookiesJD') || "[]").map(item => item.cookie)].filter(item => !!item);
}
const pkTeamNum = Math.ceil(cookiesArr.length / 30)
const JD_API_HOST = 'https://api.m.jd.com/client.action'
const { getAppCookie } = (() => {
	try {
		return require('./utils/wskeyUtils')
	} catch (e) {
		return {}
	}
})()
!(async () => {
	if (!cookiesArr[0]) {
		$.msg($.name, '【提示】请先获取京东账号--Cookie\n直接使用NobyDa的京东签到获取', 'https://bean.m.jd.com/bean/signIndex.action', {'open-url': 'https://bean.m.jd.com/bean/signIndex.action'});
		return;
	}
	const helpSysInfoArr = []
	for (let i = 0; i < cookiesArr.length; i ++) {
		if (cookiesArr[i]) {
			cookie = cookiesArr[i];
			wxCookie = wxCookieArr[i] ?? "";
			const pt_key = cookie.match(/pt_key=([^; ]+)(?=;?)/)?.[1] || ""
			if (!/app_open/.test(pt_key)) {
				getAppCookie && (cookie = await getAppCookie(cookie));
			}
			$.pin = cookie.match(/pt_pin=([^; ]+)(?=;?)/)?.[1] || ""
			$.UserName = decodeURICompnent($.pin)
			$.index = i + 1;
			$.isLogin = true;
			$.nickName = $.UserName;
			$.startActivityTime = Date.now().toString() + randomNum(1e8).toString()
			message = ''
			await TotalBean();
			console.log(`\n************开始【京东账号${$.index}】 ${$.nickName || $.UserName}*************\n`);
			if (!$.isLogin) {
				$.msg($.name, `【提示】Cookie n已失效`, `京东账号${$.index} ${$.nickName || $.UserName}\n请重新登录获取\nhttps://bean.m.jd.com/bean/signIndex.action`, {"open-url": "https://bean.m.jd.com/bean/signIndex.action"});
				if ($.isNode()) {
					await notify.sendNotify(`${$.name}Cookie已失效 -  ${$.UserName}`, `京东账号${$.index} ${$.UserName}\n请重新登录获取Cookie`)
				}
				continue;
			}
			$.UA = getUA()
			$.shshshfpb = randomUUID({
				formatData: "x".repeat(23),
				charArr: [
					...[...Array(10).keys()].map(x => String.fromCharCode(x + 48)),
					...[...Array(26).keys()].map(x => String.fromCharCode(x + 97)),
					...[...Array(26).keys()].map(x => String.fromCharCode(x + 65)),
					"/"
				],
				followCase: false
			}) + "==";
			$.__jd_ref_cls = "Babel_dev_adv_selfReproduction"
			$.ZooFaker = utils({ $ })
			$.joytoken = await getToken()
			$.blog_joytoken = await getToken("50999", "4")
			cookie = $.ZooFaker.getCookie(cookie + `joyytoken=${appid}${$.joytoken};`)
			await travel()
		}
	}
})

function TotalBean() {

}