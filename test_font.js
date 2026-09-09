const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new'});
    const page = await browser.newPage();
    await page.setContent(`
        <style>
            @font-face {
                font-family: 'Microsoft YaHei';
                src: local('__FG_BLOCK__');
            }
        </style>
        <span id='s1' style='font-family: "Microsoft YaHei", sans-serif; font-size: 72px'>mmmm</span>
        <span id='s2' style='font-family: sans-serif; font-size: 72px'>mmmm</span>
        <span id='s3' style='font-family: "Microsoft YaHei"; font-size: 72px'>mmmm</span>
    `);
    const w1 = await page.evaluate(() => document.getElementById('s1').offsetWidth);
    const w2 = await page.evaluate(() => document.getElementById('s2').offsetWidth);
    const w3 = await page.evaluate(() => document.getElementById('s3').offsetWidth);
    console.log("YaHei+sans-serif:", w1, "sans-serif:", w2, "YaHei:", w3);
    await browser.close();
})();
