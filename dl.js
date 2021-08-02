#!/bin/node
var cp = require('child_process');
var { parseStringPromise } = require('xml2js');
var fs = require('fs');
var { URLSearchParams } = require('url');
var axios = require("axios");
var puppeteer = require("puppeteer");
var cheerio = require("cheerio");

var url = process.argv[2];
if (!url) {
	console.error("no input link!");
	process.exit(1);
}

function getDLURLs(streaminfo, baseURL) {
	var highestQuality = streaminfo.Representation.pop().$;
	var toDownload = streaminfo.SegmentTemplate[0];

	var urls = [];
	var time = 0;
	urls.push(toDownload.$.initialization.replace("$RepresentationID$", highestQuality.id));
	toDownload.SegmentTimeline[0].S.forEach(segment => {
		var repeat = segment.$.r || 1;
		for(let i = 0; i < repeat; i++) {
			urls.push(toDownload.$.media
				.replace("$RepresentationID$", highestQuality.id)
				.replace("$Time$", time));
			time += Number(segment.$.d);
		}
	});

	urls = urls.map(url => baseURL + '/' + url);

	return urls;
}

async function dlURLs(urls, filename) {
	var file = fs.createWriteStream(filename);
	for (let i = 0; i < urls.length; i++) {
		console.log("downloading " + urls[i] + "...");
		var res = await axios({
			method: 'get',
			url: urls[i],
			responseType: 'arraybuffer'
		});
		file.write(res.data);
	}
	file.close();
}

(async () => {
	var browser = await puppeteer.launch();
	var page = await browser.newPage();
	await page.goto(url, { waitUntil: 'networkidle2' });
	var content = await page.content();
	await browser.close();

	var $ = cheerio.load(content);
	var src = $("iframe").attr("src");

	var res = await axios.get(src);

	var tokenId = res.data.toString().match(/(?<!var\s+?)tokenId\s+?=\s+?'(.+?)'/s)[1];
	url = "https://start-player.npo.nl/embed/" + tokenId;

	var videojs = res.data.toString().match(/^\s+var\s+?video\s+?=.+$/m).toString().trim();
	var video; eval(videojs);

	var streaminfoURL = new URLSearchParams();
	streaminfoURL.set("profile", "dash-widevine");
	streaminfoURL.set("quality", "npo");
	streaminfoURL.set("tokenId", tokenId);
	streaminfoURL.set("streamType", "broadcast");
	streaminfoURL.set("isYospace", "0");
	streaminfoURL.set("videoAgeRating", JSON.stringify(video.age_rating));
	streaminfoURL.set("isChromecast", "0");
	streaminfoURL.set("mobile", "0");
	streaminfoURL.set("ios", "0");

	var streaminfo = await axios.get(`https://start-player.npo.nl/video/${video.id}/streams?` + streaminfoURL.toString());

	var filename = video.title.toString().replace(/\s+/g, "-") + "_" +
		video.id.replace(/\s+/g, '-').toLowerCase() + "_" +
		"s" + video.seasonNumber.toString().padStart(2, '0') +
		"e" + video.episodeNumber.toString().padStart(2, '0');

	var streamSrc = streaminfo.data.stream.src;
	var xmlString = await axios.get(streamSrc);
	var baseURL = streamSrc.replace(/\/stream\.mpd$/, '');

	var xml = await parseStringPromise(xmlString.data);

	var videoStream = xml.MPD.Period[0].AdaptationSet.find(s => s.$.contentType == 'video');
	await dlURLs(getDLURLs(videoStream, baseURL), filename + '.mp4v');

	var audioStream = xml.MPD.Period[0].AdaptationSet.find(s => s.$.contentType == 'audio');
	await dlURLs(getDLURLs(audioStream, baseURL), filename + '.mp4a');

	cp.execSync(`ffmpeg -i ${filename}.mp4v -i ${filename}.mp4a -map 0:0 -map 1:0 ${filename}.mp4`);
	
	fs.rmSync(filename + '.mp4v');
	fs.rmSync(filename + '.mp4a');
})();

