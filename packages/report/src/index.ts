export { renderHtml, esc } from './html.js';
export { renderTerminal } from './terminal.js';
export { renderJson } from './json.js';
export { renderJunit, escapeXml } from './junit.js';
export { renderMarkdown } from './markdown.js';
export {
  SVG_CANDIDATE_COLOR,
  SVG_REFERENCE_COLOR,
  renderHistogram,
  type HistogramInput,
} from './svg.js';
export {
  DRILL_DOWN_CAP,
  DRILL_DOWN_NO_PATH,
  controlExchanges,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPercent,
  fmtRate,
  invariantSummary,
  mismatchedExchanges,
  pacingLine,
  planDrillDown,
  topMismatchPaths,
  verdictLabel,
  type DrillDownGroup,
  type DrillDownPlan,
} from './format.js';
export {
  readExchangesSidecar,
  sidecarLocation,
  withSidecarExchanges,
  type LoadedExchanges,
} from './sidecar.js';
