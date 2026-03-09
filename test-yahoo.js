async function test() {
  const res = await fetch("https://cookie04.finance.yahoo.com/v1/test/getcrumb", { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const crumb = await res.text();
  console.log("Crumb:", crumb);
}
test();
