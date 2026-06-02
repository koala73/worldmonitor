# Country Profile Feature Implementation

## Overview

A comprehensive country-focused intelligence dashboard feature has been added to WorldMonitor, enabling users to:
- Search for and select countries from a searchable database
- View a modal overlay with country-specific intelligence across all domains
- Track real-time alerts and updates filtered by the selected country
- Quickly switch between different countries without losing the main dashboard

## Components Created

### 1. **CountrySelector** (`src/components/CountrySelector.ts`)
A unified country selection interface featuring:
- **Search Box**: Filter countries by name or ISO code
- **Quick-Select Buttons**: Fast access to 20+ frequently monitored countries (US, CN, RU, UA, IL, IR, etc.)
- **Full Country List Dropdown**: Scrollable list of 195+ countries with flags and ISO codes
- Keyboard navigation (Escape to close)
- Click-outside to close

**Usage:**
```typescript
const selector = new CountrySelector({
  onCountrySelected: (code, name) => handleCountrySelect(code, name),
  onClose: () => handleClose(),
});
selector.updateStyles(); // Inject CSS
```

### 2. **CountryProfileView** (`src/components/CountryProfileView.ts`)
Modal overlay displaying country-focused intelligence with:
- **Header Section**: Country flag, name, ISO code, real-time status indicator
- **Mini-Panels Grid**: Real-time data cards for:
  - Military Presence (flights, vessels)
  - Economic Indicators
  - Energy Profile
  - Cyber Threats
  - Health & Humanitarian Status
- **Main Panel Area**: CountryDeepDivePanel for comprehensive country analysis
- Responsive design (95% width, adapts to mobile)
- Smooth animations and visual hierarchy

**Key Features:**
- Real-time data updates
- Blue status indicator with pulsing animation
- Full-screen modal with backdrop blur
- Close button and Escape key support
- Integration with existing CountryDeepDivePanel

### 3. **CountryProfilePanel** (`src/components/CountryProfilePanel.ts`)
A panel component extending the base Panel class:
- Aggregates country intelligence across multiple domains
- Displays in the main dashboard grid (can be enabled/disabled)
- Shows a prompt when no country is selected
- Renders risk score badge (critical/high/medium/low)
- Lists recent headline events
- Connects to the CountryProfileManager

### 4. **CountryProfileManager** (`src/app/country-profile-manager.ts`)
Orchestrator managing:
- Country selector modal lifecycle
- Country profile view creation/destruction
- Data loading and filtering by country
- Real-time subscription management
- Integration with AppContext

**Key Methods:**
```typescript
manager.openCountrySelector(); // Show country picker
manager.selectCountry(code, name); // Select and display country
manager.closeCountryProfile(); // Close profile overlay
manager.getSelectedCountryCode(); // Get current selection
manager.updateCountryProfile(); // Refresh data
```

## Integration with App State

### App.ts Changes
1. Import added: `import { CountryProfileManager } from '@/app/country-profile-manager';`
2. Property added: `private countryProfileManager: CountryProfileManager | null = null;`
3. Initialization in constructor: Creates CountryProfileManager instance
4. Module tracking: Added to modules array for proper lifecycle management
5. Public API methods:
   - `openCountrySelector()`: Trigger country selector
   - `closeCountryProfile()`: Close the profile view
   - `getSelectedCountryCode()`: Query selected country

### Panel Layout Changes
1. CountryProfilePanel imported and registered
2. Panel creation logic added with AppContext binding
3. Conditional creation based on variant configuration

### Configuration Changes (`src/config/panels.ts`)
Added to FULL_PANELS:
```typescript
'country-profile': { name: 'Country Profile', enabled: false, priority: 1 }
```

Note: Panel is disabled by default but available in full variant for users to enable if desired.

## Data Flow

```
User → CountrySelector (search/select)
       ↓
CountryProfileManager.selectCountry()
       ↓
CountryProfileView (modal created)
       ↓
Load country-specific data:
  - Military activity (flights, vessels)
  - Economic indicators (markets, indices)
  - Cyber threats
  - Energy profile
  - Recent news/events
       ↓
Real-time updates via data-loader integration
```

## Usage Examples

### Opening Country Selector
```typescript
// From App instance
app.openCountrySelector();
```

### Handling Country Selection
The CountrySelector automatically:
1. Opens the country selection modal
2. On selection, creates CountryProfileView
3. Loads country-specific data
4. Displays in full-screen overlay
5. Closes selector and shows profile

### Accessing from UI
Users can:
1. Add the CountryProfilePanel to their dashboard (enable in variant config)
2. Click a country on the map (if integrated with map click handlers)
3. Search for countries via main SearchModal integration
4. Use WebMCP tools if available

## Styling Features

### CountrySelector
- Dark theme with accent colors
- Flag emojis for visual identification
- Quick-select grid layout (auto-fill)
- Smooth hover effects
- Monospace font for country codes

### CountryProfileView
- Large flag display (48px)
- Color-coded risk badge (red/orange/yellow/green)
- Grid layout for mini-panels (responsive 350px min-width)
- Pulsing status indicator
- Full-screen modal with backdrop blur

### CountryProfilePanel
- Compact indicator cards with icons (🛡️🔒📡)
- Event list with accent-colored left border
- Risk badge with status-specific colors
- Responsive grid layout

## Real-time Data Integration

The system is designed to work with WorldMonitor's existing data-loader:

1. **News Filtering**: `__COUNTRY_PROFILE_NEWS` window variable stores filtered news
2. **Risk Scores**: `__COUNTRY_RISK_SCORES` stores country risk calculations
3. **Military Data**: Filters existing military flights/vessels by country code
4. **Cyber Threats**: Filters cyber threat cache by country code
5. **Markets**: Filters market data by country code

## Translation Support

All user-facing strings use the i18n system:
- `country_selector.search_placeholder`
- `country_selector.quick_select`
- `country_profile.realtime`
- `country_profile.viewing`
- `panels.countryProfile`
- `panels.riskScore`
- `panels.militaryActivity`
- And more...

## Future Enhancements

### Phase 2: Advanced Features
1. **Map Integration**: Click on map to open country profile
2. **Bookmark Countries**: Save favorite countries for quick access
3. **Country Comparison**: Compare 2-3 countries side-by-side
4. **Historical Timeline**: View country intelligence over time
5. **Export Functionality**: Download country profile as PDF/CSV

### Phase 3: Deep Analytics
1. **Correlation Analysis**: See how events in one country affect others
2. **Supply Chain Mapping**: Trace dependencies from selected country
3. **Economic Shock Scenarios**: Model impact of disruptions
4. **Predictive Alerts**: ML-based risk forecasting

### Phase 4: API Integration
1. **Country-scoped Endpoints**: `/api/country/{code}/intelligence`
2. **Batch Country Profiles**: `/api/countries/batch`
3. **Country Risk Forecasts**: `/api/country/{code}/forecast`
4. **Historical Data**: `/api/country/{code}/history`

## Testing Checklist

- [ ] CountrySelector opens and displays countries
- [ ] Search filters countries correctly
- [ ] Quick-select buttons work
- [ ] Country selection triggers CountryProfileView
- [ ] CountryProfileView displays correct country info
- [ ] Close button and Escape key close the modal
- [ ] CountryProfilePanel can be enabled in variant config
- [ ] Real-time data updates when new intelligence arrives
- [ ] Multiple countries can be sequenced (select → close → select different)
- [ ] Mobile responsiveness (overlay fits screen)
- [ ] Keyboard navigation works
- [ ] Flag emojis render correctly
- [ ] Styling matches dark theme

## File Locations

```
src/
├── components/
│   ├── CountrySelector.ts          ← Country search/select UI
│   ├── CountryProfileView.ts       ← Modal overlay
│   ├── CountryProfilePanel.ts      ← Dashboard panel
│   └── index.ts                    ← Updated exports
├── app/
│   ├── country-profile-manager.ts  ← Orchestrator
│   ├── panel-layout.ts             ← Updated with panel creation
│   └── app-context.ts              ← (no changes needed)
├── config/
│   └── panels.ts                   ← Added to ALL_PANELS
└── App.ts                          ← Integration point
```

## Dependencies

- No new external dependencies required
- Uses existing WorldMonitor services:
  - country-geometry (ISO codes, country lookups)
  - i18n (translations)
  - data-loader (real-time updates)
  - auth-state (premium gating)
- DOM utilities: `h()`, `replaceChildren()`, `safeHtml()`
- Flag emojis via `toFlagEmoji()` utility

## Architecture Notes

### Separation of Concerns
1. **CountrySelector**: Pure UI for selection
2. **CountryProfileView**: Pure UI for display
3. **CountryProfileManager**: State and lifecycle management
4. **CountryProfilePanel**: Integration with dashboard
5. **App.ts**: Wiring and public API

### Memory Management
- Event listeners properly cleaned up
- AbortController patterns for fetch cancellation
- Module destruction in reverse order (lifecycle)
- Window event listeners removed on destroy

### Accessibility
- ARIA labels on inputs
- Keyboard navigation (Escape)
- Semantic HTML (buttons, lists)
- Color-coded but not color-only (icons + text)

## Next Steps for Developers

1. **Enable Country Selection UI**: Add a button to the main menu or header to trigger `app.openCountrySelector()`
2. **Implement Map Integration**: Wire up map click handler to country codes
3. **Add to Search**: Integrate with SearchModal for country lookup
4. **Backend Endpoints**: Create `/api/country/{code}/*` endpoints for aggregated data
5. **Real-time Subscriptions**: Wire WebSocket updates for selected country
6. **Mobile Optimization**: Further refinement of mobile UI
7. **Analytics**: Track which countries users are viewing

## Performance Considerations

- CountrySelector renders full country list (195+) but uses efficient DOM manipulation
- CountryProfileView lazy-loads panels as needed
- Mini-panels update independently for responsive feedback
- Grid layout uses CSS Grid for optimal layout performance
- Styles injected once and cached in document head
