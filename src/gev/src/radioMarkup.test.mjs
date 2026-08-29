import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const radio = readFileSync(new URL('./data/radio.js', import.meta.url), 'utf8');
const rocketLaunches = readFileSync(new URL('./data/rocketLaunches.js', import.meta.url), 'utf8');
const realtime = readFileSync(new URL('./voice/gevRealtime.js', import.meta.url), 'utf8');
const voice = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

/** Parse the Realtime tool array out of the Vite config as real data. */
function realtimeTools() {
  const start = voice.indexOf('const GEV_REALTIME_TOOLS = [');
  const end = voice.indexOf('\n];', start);
  assert.ok(start >= 0 && end > start, 'Realtime tool schema block is missing');
  const literal = voice.slice(start + 'const GEV_REALTIME_TOOLS = '.length, end + 2);
  // The block is pure data; evaluating it beats regexing nested schemas.
  return new Function(`return ${literal};`)();
}

test('Realtime schema exposes the authoritative 28-tool inventory', () => {
  const tools = realtimeTools();
  assert.equal(tools.length, 28);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 28, 'tool names are unique');
  assert.ok(names.includes('set_context_mode'));
  assert.ok(names.includes('control_cockpit'));
  assert.ok(names.includes('select_nearest_aircraft'));
  assert.ok(names.includes('control_radio'));
  // Every tool closes its parameter object: an open schema lets the model
  // invent arguments the runner silently drops.
  for (const tool of tools) {
    assert.equal(tool.type, 'function', `${tool.name} is not a function tool`);
    assert.equal(
      tool.parameters?.additionalProperties,
      false,
      `${tool.name} does not close additionalProperties`,
    );
    assert.ok(tool.description, `${tool.name} has no description`);
  }
});

test('the counting contract is stated in the Realtime instructions', () => {
  // Product decision: "near" has one meaning per state, and every count names its
  // scope. Instruction text is the only place the narration rules can live, so
  // it is pinned — a silent trim here is a silent behaviour change.
  const start = voice.indexOf("'COUNTING CONTRACT");
  assert.ok(start >= 0, 'the counting contract instruction is missing');
  // One instruction per source line; the string carries escaped quotes, so take
  // the line rather than trying to match a quoted literal.
  const text = voice.slice(start, voice.indexOf('\n', start));
  assert.match(text, /Contacts is ACTIVE/, 'rule 1: active means the Contacts window');
  assert.match(text, /contactsWindow/, 'rule 1 names its mechanism');
  assert.match(text, /call set_context_mode\{mode:"contacts"\} first/);
  assert.match(text, /contactsWindow\.aircraft/);
  assert.match(text, /Contacts OFF, "nearby" means in view/, 'rule 2: off means in view');
  assert.match(text, /EVERY count names its scope in words/, 'rule 3');
  assert.match(text, /scopeLabel/, 'rule 3 names its mechanism');
  assert.match(text, /never a bare number/, 'rule 3 is stated as a prohibition too');
  assert.match(text, /VERBATIM/, 'rule 4: no estimating');
  assert.match(text, /flights layer loads where you look/, 'rule 5: the loaded-data caveat');
});

test('Context panel opening stays distinct from Contacts activation', () => {
  const start = voice.indexOf("'For requests to open, show, reveal, or focus a menu/panel");
  assert.ok(start >= 0, 'panel-routing instruction is missing');
  const text = voice.slice(start, voice.indexOf('\n', start));
  assert.match(text, /"Open Context" means only set_panel_open/);
  assert.match(text, /does not activate a Context sub-mode/);
  assert.match(text, /"Open Contacts" means set_context_mode\{mode:"contacts"\}/);
  assert.match(text, /expands the parent Context panel before activating Contacts/);
});

test('nearest-aircraft selection stays out of Contacts and Cockpit', () => {
  const start = voice.indexOf("'For a request to enable an aircraft layer and SELECT or FIND");
  assert.ok(start >= 0, 'nearest-aircraft selection routing instruction is missing');
  const text = voice.slice(start, voice.indexOf('\n', start));
  assert.match(text, /Turn on flights and select the closest aircraft to Austin/);
  assert.match(text, /call select_nearest_aircraft once/);
  assert.match(text, /atomically turns on the requested aircraft layer first/);
  assert.match(text, /waits for location arrival/);
  assert.match(text, /refreshes that layer for the destination viewport/);
  assert.match(text, /filters out landed\/on-ground records/);
  assert.match(text, /nearest airborne result/);
  assert.match(text, /healthy fallback feed is valid data/i);
  assert.match(text, /Do not also call fly_to_location, set_layer_visibility, analyst_query, track_entity/);
  assert.match(text, /SELECT\/FIND never implies Contacts or Cockpit/);
  assert.match(text, /set_context_mode, or control_cockpit/);

  const byName = new Map(realtimeTools().map((tool) => [tool.name, tool]));
  assert.match(byName.get('set_context_mode').description, /explicitly requests/);
  assert.match(byName.get('set_context_mode').description, /selecting an aircraft does not imply Context/i);
  assert.match(byName.get('control_cockpit').description, /explicitly requests Cockpit/);
  assert.match(byName.get('control_cockpit').description, /must not enter Cockpit/);
  assert.equal(
    byName.get('fly_to_location').parameters.properties.waitForArrival.type,
    'boolean',
  );
  const nearest = byName.get('select_nearest_aircraft');
  assert.deepEqual(nearest.parameters.required, ['layerId']);
  assert.deepEqual(nearest.parameters.properties.layerId.enum, ['flights', 'military']);
  assert.match(nearest.description, /Atomically/);
  assert.match(nearest.description, /exclude on-ground records/);
  assert.match(nearest.description, /fallback feeds remain usable/);
  assert.match(nearest.description, /does not open Contacts or Cockpit/);
});

test('the two Context/Cockpit tools pin their enums and required arguments', () => {
  const byName = new Map(realtimeTools().map((tool) => [tool.name, tool]));

  const contextMode = byName.get('set_context_mode');
  assert.deepEqual(contextMode.parameters.required, ['mode']);
  assert.deepEqual(
    contextMode.parameters.properties.mode.enum,
    ['off', 'contacts', 'flights', 'space-missions', 'missions'],
  );

  const cockpit = byName.get('control_cockpit');
  assert.deepEqual(cockpit.parameters.required, ['action']);
  assert.deepEqual(
    cockpit.parameters.properties.action.enum,
    ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
  );
  assert.deepEqual(
    cockpit.parameters.properties.targetLayer.enum,
    ['flights', 'military', 'ais-live-vessels', 'military-installations'],
    'the layer filter must match the four Context cohorts exactly',
  );
  // aircraftClass is deliberately open (free-form class names), but still typed.
  assert.equal(cockpit.parameters.properties.aircraftClass.type, 'string');
  assert.equal(cockpit.parameters.properties.aircraftClass.enum, undefined);
});

test('the edited existing tools changed exactly as intended', () => {
  const byName = new Map(realtimeTools().map((tool) => [tool.name, tool]));

  // Edit 1: the Context panel became voice-addressable alongside set_context_mode.
  const panel = byName.get('set_panel_open');
  assert.deepEqual(
    panel.parameters.properties.panelId.enum,
    ['data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'scene-panel', 'pp-toggles', 'global-context-panel'],
  );
  assert.deepEqual(panel.parameters.required, ['panelId', 'open']);

  // Edit 2: description only — the view state now reports Context and Cockpit.
  const viewState = byName.get('get_current_view_state');
  assert.match(viewState.description, /Context, Cockpit/);
  assert.deepEqual(viewState.parameters.properties, {});

  // Edit 3: dependent multi-tool navigation can wait for the destination view.
  const location = byName.get('fly_to_location');
  assert.equal(location.parameters.properties.waitForArrival.type, 'boolean');
  assert.match(location.parameters.properties.waitForArrival.description, /arrived=true/);
});

test('no unchanged Realtime tool definition drifts silently', () => {
  // Context/Cockpit parity, the dependent-location wait edit, and the retired
  // `bing-road` stack leaving `set_map_stack`'s enum are the known schema
  // changes. Everything else must be byte-identical: an unnoticed edit
  // to a shipped tool changes
  // model behavior in production with nothing in review to catch it.
  //
  // If this fails and the change was deliberate, re-derive the digest and say
  // in the mic-test brief which tools moved — the session cache busts on any
  // schema change.
  const TOUCHED = new Set([
    'set_context_mode',
    'control_cockpit',
    'set_panel_open',
    'get_current_view_state',
    'fly_to_location',
    'select_nearest_aircraft',
    'set_map_stack',
  ]);
  const unchanged = realtimeTools()
    .filter((tool) => !TOUCHED.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(unchanged.length, 21);
  const digest = createHash('sha256')
    .update(JSON.stringify(unchanged))
    .digest('hex')
    .slice(0, 16);
  assert.equal(digest, '802ed694b8887b88', 'an unchanged Realtime tool definition drifted');
});

test('Radio volume and mission speed share the Sharpen slider visual language', () => {
  for (const id of ['cockpit-radio-volume', 'context-radio-mini-volume', 'radio-volume']) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*class="gev-quantitative-slider"[^>]*type="range"`),
    );
  }
  assert.match(
    rocketLaunches,
    /id="space-mission-replay-speed" class="gev-quantitative-slider" type="range" min="0\.25" max="4" step="0\.25" value="1"/,
  );
  assert.match(rocketLaunches, /class="gev-slider-value"[^>]*data-mission-replay-speed-output/);
  assert.match(css, /\.gev-quantitative-slider\s*\{[\s\S]*?min-width: 0;[\s\S]*?height: 18px;/);
  assert.match(css, /\.gev-quantitative-slider::-webkit-slider-runnable-track\s*\{[\s\S]*?height: 3px;[\s\S]*?background: rgba\(255, 255, 255, 0\.08\);/);
  assert.match(css, /\.gev-quantitative-slider::-webkit-slider-thumb\s*\{[\s\S]*?width: 10px;[\s\S]*?height: 10px;[\s\S]*?border-radius: 50%;[\s\S]*?background: var\(--accent\);/);
  assert.match(css, /\.gev-quantitative-slider:focus-visible\s*\{[\s\S]*?outline: 1px solid/);
  assert.match(css, /\.gev-quantitative-slider:disabled\s*\{[\s\S]*?opacity: \.42;[\s\S]*?cursor: not-allowed;/);
  assert.match(css, /\.gev-slider-value\s*\{[\s\S]*?color: var\(--accent\);[\s\S]*?font-size: 9px;/);
  assert.doesNotMatch(css, /#space-mission-panel \[data-mission-replay-speed\]::-webkit-slider-thumb/);
});

test('Radio is nested inside Context with separate disclosure and power controls', () => {
  const contextStart = html.indexOf('id="global-context-panel"');
  const radioStart = html.indexOf('id="radio-panel"');
  const contextEnd = html.indexOf('\n  </aside>', contextStart);
  assert.ok(contextStart >= 0 && radioStart > contextStart && radioStart < contextEnd);
  assert.match(html, /id="radio-panel"[^>]*data-panel-id="radio-panel"/);
  assert.match(html, /aria-label="Radio playback"/);
  assert.match(html, /id="context-radio-toggle-btn"[^>]*aria-expanded="false"[^>]*aria-controls="context-radio-mini"/);
  assert.doesNotMatch(html, /id="context-radio-toggle-btn"[^>]*aria-pressed=/);
  assert.match(html, /id="context-radio-mini"[^>]*aria-label="Compact Radio controls"[^>]*hidden/);
  assert.match(html, /id="context-radio-mini-enable-btn"[^>]*aria-pressed="false"/);
  assert.match(html, /id="context-radio-details-btn"[^>]*aria-expanded="false"[^>]*aria-controls="radio-panel"/);
  assert.match(html, /id="context-radio-details-btn"[\s\S]*?<span class="material-symbols-outlined" aria-hidden="true">open_in_full<\/span>/);
  assert.match(html, /id="context-radio-mini-close-btn"[^>]*aria-label="Close compact Radio controls"/);
  assert.match(html, /id="context-radio-mini-(?:prev|play|next)-btn"/);
  assert.match(html, /id="context-radio-mini-volume"/);
  assert.match(html, /id="cockpit-radio-panel"[^>]*aria-label="Cockpit compact Radio controls"[^>]*hidden/);
  assert.match(html, /id="cockpit-radio-enable-btn"[^>]*aria-pressed="false"/);
  assert.match(html, /id="cockpit-radio-(?:prev|play|next)-btn"/);
  assert.match(html, /id="cockpit-radio-volume"/);
  assert.match(html, /id="radio-tuner"[^>]*hidden/);
  assert.match(html, /id="radio-tuner-band-label">DIRECTORY BAND/);
  assert.match(html, /id="radio-tuner-slider"[^>]*type="range"/);
  assert.match(html, /id="radio-tuner-needle"[^>]*aria-hidden="true"/);
  assert.match(html, /SNAPS TO AVAILABLE STATIONS/);
  assert.match(html, /class="radio-tuner-scale" aria-hidden="true"><\/div>/);
  assert.match(html, /DIRECTORY: RADIO BROWSER/);
  assert.match(html, /Audio connects directly to the broadcaster/);
  assert.doesNotMatch(html, /radio-(?:favicon|visualizer|spectrum)/i);
  assert.match(css, /#radio-tuner-slider::-(?:webkit-slider-thumb|moz-range-thumb)/);
  assert.match(css, /\.radio-tuner\.is-static/);
  assert.match(css, /\.radio-tuner-tick\s*\{/);
  assert.doesNotMatch(css, /radio-tuner-scale-(?:left|right)/);
  assert.match(css, /\.radio-tuner-needle\s*\{[\s\S]*?transition: left \.18s ease-out;/);
  assert.match(css, /\.radio-tuner\.is-dragging \.radio-tuner-needle,[\s\S]*?\.radio-tuner\.is-dragging \.radio-tuner-tick\s*\{\s*transition: none;/);
  assert.match(css, /\.radio-tuner\s*\{[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden;/);
  assert.match(css, /#radio-tuner-slider\s*\{[\s\S]*?max-width: 100%;[\s\S]*?touch-action: none;/);
  assert.match(css, /#title-bar\.radio-broadcasting \.title-logo::before/);
  assert.match(css, /#title-bar\.radio-broadcasting \.title-logo::after/);
  assert.match(css, /--radio-broadcast-opacity: \.17/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.radio-tuner-needle,[\s\S]*?\.radio-tuner-tick\s*\{\s*transition: none;/);
  assert.doesNotMatch(ui, /_radioTunerCameraRemove = this\.viewer\?\.camera\?\.changed/);
  assert.match(ui, /classList\.toggle\('radio-broadcasting', state\.audioState === 'playing'\)/);
  assert.match(ui, /cycleStation\(direction, \{[\s\S]*?rotate,[\s\S]*?stationIds:/);
  const cycleStart = ui.indexOf('const cycleRadio = (direction, { rotate = true } = {}) =>');
  const cycleMethod = ui.slice(cycleStart, ui.indexOf('const toggleRadio', cycleStart));
  assert.doesNotMatch(cycleMethod, /refreshTunerBand/);
  assert.match(ui, /_radioTunerBandPinnedForNavigation = true/);
  assert.match(ui, /viewer\?\.canvas\?\.addEventListener\('pointerdown', releaseNavigationBand/);
  assert.match(ui, /previewTuningStation\(station\?\.id \|\| null, \{ rotate \}\)/);
  assert.match(ui, /tunerPreview\(\{ coordinate: this\._radioTunerCoordinate, rotate: commit \}\)/);
  assert.match(ui, /radioLayer\.cancelTuning\(\)/);
  assert.match(ui, /classList\.remove\('radio-broadcasting'\)/);
  assert.match(ui, /radioLayer\.getTunerStations\(750\)/);
  assert.match(ui, /radioTunerPointerPosition\(/);
  assert.doesNotMatch(css, /#right-context-rail\s*>\s*#radio-panel/);
  assert.match(css, /#global-context-panel #radio-panel\.collapsed/);
  assert.doesNotMatch(css, /\.context-radio-dock\.active:hover \.context-radio-mini/);
  assert.doesNotMatch(css, /\.context-radio-dock\.active:focus-within \.context-radio-mini/);
  assert.match(css, /#right-context-rail #global-context-panel:not\(\.collapsed\) \.context-mode-view,[\s\S]*?#right-context-rail #global-context-panel:not\(\.collapsed\) #radio-panel\s*\{[\s\S]*?flex: 0 0 auto;/);
});

test('panel collapse is presentation-only and Radio exposes explicit voice playback controls', () => {
  const start = ui.lastIndexOf('\n  setPanelCollapsed(panelId');
  const method = ui.slice(start, ui.indexOf('toggleCleanView(forceEnabled)', start));
  assert.doesNotMatch(method, /stopRadio|stopPlayback|setEnabled\('radio'/);
  assert.match(voice, /'radio-panel'/);
  assert.match(voice, /'radio'/);
  assert.match(voice, /name:\s*'control_radio'/);
  assert.match(voice, /enum:\s*\['enable', 'disable', 'play', 'resume', 'pause', 'stop', 'next', 'previous', 'volume', 'select', 'status'\]/);
  const enableStart = ui.lastIndexOf('\n  _initRadioPanel()');
  const enableMethod = ui.slice(enableStart, ui.indexOf('\n  _renderRadioState(state)', enableStart));
  assert.doesNotMatch(enableMethod, /playSelectedRadio|togglePlayback\(\).*radio-enable/i);
  assert.match(enableMethod, /contextRadioToggleBtn/);
  assert.match(enableMethod, /contextRadioMiniEnableBtn/);
  assert.match(enableMethod, /contextRadioDetailsBtn/);
  assert.match(enableMethod, /contextRadioMiniCloseBtn/);
  assert.match(enableMethod, /contextRadioMiniPlayBtn/);
  const disclosureStart = enableMethod.indexOf('this._contextRadioToggleBtn?.addEventListener');
  const disclosureEnd = enableMethod.indexOf("this._radioFilter?.addEventListener", disclosureStart);
  const disclosureBindings = enableMethod.slice(disclosureStart, disclosureEnd);
  assert.ok(disclosureStart >= 0 && disclosureEnd > disclosureStart, 'compact Radio disclosure bindings are missing');
  assert.doesNotMatch(disclosureBindings, /toggleRadio\(this\._contextRadioToggleBtn\)/);
  assert.match(enableMethod, /toggleRadio\(this\._contextRadioMiniEnableBtn\)/);
  assert.match(disclosureBindings, /contextRadioMiniCloseBtn[\s\S]*?setRadioDisclosure\(false, \{ returnFocus: true \}\)/);
  assert.match(disclosureBindings, /contextRadioDetailsBtn[\s\S]*?setPanelCollapsed\('radio-panel', false, \{ explicit: true \}\)/);
  assert.match(
    disclosureBindings,
    /contextRadioToggleBtn[\s\S]*?!contextPanel\.classList\.contains\('collapsed'\)[\s\S]*?setRadioDisclosure\(false\)[\s\S]*?setPanelCollapsed\('radio-panel', false, \{ explicit: true \}\)[\s\S]*?_revealRadioPanelInsideContext/,
  );
  assert.doesNotMatch(disclosureBindings, /setPanelCollapsed\('radio-panel', !/);
  assert.match(ui, /setAttribute\('aria-expanded', String\(/);
  assert.match(ui, /\.hidden = !/);
  assert.doesNotMatch(method, /panelId === 'global-context-panel'[\s\S]*?this\._radioState\?\.enabled[\s\S]*?setPanelCollapsed\('radio-panel', false\)/);
});

test('expanded Context routes its Radio icon to the embedded section and keeps collapsed Context compact', () => {
  const revealStart = ui.indexOf('\n  async _revealRadioPanelInsideContext');
  const revealEnd = ui.indexOf('\n  /**', revealStart + 10);
  const revealMethod = ui.slice(revealStart, revealEnd);
  assert.ok(revealStart >= 0 && revealEnd > revealStart, 'embedded Radio reveal helper is missing');
  assert.match(revealMethod, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(revealMethod, /scroller\.scrollTo\(\{ top: next, behavior: reducedMotion \? 'auto' : 'smooth' \}\)/);
  assert.match(revealMethod, /focus\?\.\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(revealMethod, /setEnabled|togglePlayback|selectStation|setContextMode/);

  const syncStart = ui.indexOf('\n  _syncContextRadioLauncherState()');
  const syncEnd = ui.indexOf('\n  /**', syncStart + 10);
  const syncMethod = ui.slice(syncStart, syncEnd);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'Context Radio launcher state sync is missing');
  assert.match(syncMethod, /contextExpanded[\s\S]*?aria-controls', 'radio-panel'[\s\S]*?aria-expanded', String\(radioExpanded\)/);
  assert.match(syncMethod, /aria-controls', 'context-radio-mini'[\s\S]*?aria-expanded', String\(compactOpen\)/);
  const renderStart = ui.indexOf('\n  _renderRadioState(state)');
  const renderMethod = ui.slice(renderStart, ui.indexOf('\n  _renderRadioTuner', renderStart));
  assert.match(renderMethod, /this\._syncContextRadioLauncherState\(\)/);
  assert.doesNotMatch(renderMethod, /compact Radio controls/);
  assert.doesNotMatch(renderMethod, /_contextRadioToggleBtn\.setAttribute\('aria-(?:controls|expanded|label)'/);
});

test('Radio disclosure is explicit, starts closed while off, and preserves playback state', () => {
  const renderStart = ui.indexOf('\n  _renderRadioState(state)');
  const renderMethod = ui.slice(renderStart, ui.indexOf('\n  _renderRadioTuner', renderStart));
  assert.ok(renderStart >= 0, 'Radio render method is missing');
  assert.doesNotMatch(renderMethod, /setPanelCollapsed\('radio-panel', true\).*stopPlayback/s);
  assert.doesNotMatch(renderMethod, /_radioMiniExpanded\s*=\s*false.*audioState === 'playing'/s);
  assert.match(ui, /contextRadioDetailsBtn/);
  const syncStart = ui.indexOf('\n  _syncPanelCollapseButton(panelEl)');
  const syncMethod = ui.slice(syncStart, ui.indexOf('\n  /**', syncStart + 10));
  assert.doesNotMatch(syncMethod, /contextRadioDetailsBtn[\s\S]*?(?:aria-label|textContent|\.title)/);
});

test('successful explicit user playback hands the speaker from voice to Radio', () => {
  const playStart = radio.indexOf('export async function playSelectedRadio');
  const playMethod = radio.slice(playStart, radio.indexOf('\n/**', playStart + 10));
  const confirmedPlaying = playMethod.indexOf("_audioState = 'playing'");
  const takeoverSignal = playMethod.indexOf("if (origin === 'user') emitPlaybackControl('play', origin, ownedAttemptId)");
  assert.ok(confirmedPlaying >= 0 && takeoverSignal > confirmedPlaying);
  assert.match(radio, /startPlayback: \(\) => playSelectedRadio\(\{ origin: 'voice', attemptId: options\.attemptId \}\)/);
  assert.match(radio, /selectRadioStation\(stationId, \{ autoplay: true, origin: 'user' \}\)/);
  assert.match(ui, /togglePlayback\(\{ origin: 'user' \}\)/);
  assert.match(ui, /cycleStation\(direction, \{[\s\S]*?origin: 'user'/);
  assert.match(ui, /commitTuningStation\(station\.id, \{ origin: 'user' \}\)/);
  assert.match(realtime, /event\.origin === 'user' && event\.action === 'play' && this\.isActive\(\)[\s\S]*?this\.stop\(\{ preserveRadioPlayback: true \}\)/);
});
