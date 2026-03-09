async function testYahoo() {
    const res = await fetch("https://finance.yahoo.com/calendar/earnings?day=2024-10-18", { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const match = html.match(/root\.App\.main = (\{.*?\});\n/);
    if (match) {
        const data = JSON.parse(match[1]);
        console.log(Object.keys(data.context.dispatcher.stores));
    } else {
        console.log("No JSON found");
    }
}
testYahoo();
