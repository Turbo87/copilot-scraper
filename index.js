import { writeFile, mkdir, access } from 'node:fs/promises';
import puppeteer from 'puppeteer';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(page, url) {
    for (let i = 0;; i++) {
        let response = await page.goto(url);
        if (response.ok()) {
            return;
        }

        let default_delay = 5000;
        let retry_after = response.headers()['retry-after'];
        let delay = retry_after ? parseInt(retry_after) / 5 * 1000 : default_delay;

        console.log(`Request failed: ${response.status()} ${response.statusText()}`);
        console.log(`Retrying in ${delay}ms…`);
        await sleep(delay);
    }
}

async function login(page, email, password) {
    console.log(`Logging in as "${email}"…`);
    await retry(page, 'https://copilot.segelflug.aero/');

    await page.type('input[name="user"]', email);
    await page.type('input[name="pwinput"]', password);
    await page.click('button[name="submitbtn"]');
}

async function competition_info(page, id) {
    id = String(id);

    await retry(page, `https://copilot.segelflug.aero/competition/info?coid=${id}`);

    let title;
    try {
        title = await page.$eval('.infoheader', el => el.textContent);
    } catch {
        return;
    }

    let rows = await page.$$('.infotable:nth-of-type(4) tr:not(:first-child)');
    if (rows.length === 0) {
        rows = await page.$$('.infotable:nth-of-type(3) tr:not(:first-child)');
    }

    let classes = {};
    for (let row of rows) {
        let [name, registrations, pilots, _, max_score] =
            await row.evaluate(el => [...el.querySelectorAll('td')].map(td => td.textContent));

        registrations = parseInt(registrations);
        pilots = parseInt(pilots);
        max_score = parseInt(max_score);

        classes[name] = { registrations, pilots, max_score };
    }

    return {id, title, classes};
}

async function competition_results(page, id) {
    let results = [];
    for (let i = 1; ; i++) {
        await retry(page, `https://copilot.segelflug.aero/competition/results/?coid=${id}&page=${i}`);

        let url = page.url()
        if (url.includes('orgpage=')) {
            break;
        }

        let rows2 = await page.$$('.tablelist tr:not(:first-child)');
        if (rows2.length === 0) {
            break;
        }
        for (let row of rows2) {
            let [name, _competition, _state, _date, class_name, score, copilot_points] =
                await row.evaluate(el => [...el.querySelectorAll('td')].map(td => td.textContent));

            let user_link = await row.evaluate(el => el.querySelector('td:first-child a').href);
            let id = new URL(user_link).searchParams.get('uid');

            score = parseInt(score);
            copilot_points = parseFloat(copilot_points);
            results.push({name, id, class_name, score, copilot_points});
        }
    }
    return results;
}

async function load_competitions(email, password, start, end) {
    const browser = await puppeteer.launch({headless: 'new'});
    const page = await browser.newPage();

    await login(page, email, password);

    await mkdir('data', {recursive: true});
    for (let id = start; id <= end; id++) {
        let path = `data/${id}.json`;

        try {
            await access(path);
            continue;
        } catch {
        }

        console.log(`Loading competition… id=${id}`);

        let info = await competition_info(page, id);
        if (!info) {
            continue;
        }

        console.log(`Loading competition results… id=${id} title=${info.title}`);
        info.results = await competition_results(page, id);

        await writeFile(path, JSON.stringify(info, null, 2));
    }

    await browser.close();
}

(async () => {
    if (!process.env.COPILOT_EMAIL || !process.env.COPILOT_PASSWORD) {
        console.log('Please set COPILOT_EMAIL and COPILOT_PASSWORD environment variables.');
        return;
    }

    await load_competitions(process.env.COPILOT_EMAIL, process.env.COPILOT_PASSWORD, 1, 1200);
})();
