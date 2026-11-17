"use strict";
// Test-only: injected by serve.ps1 (-HeadersFile) as the first script of HTML pages. Records every CSP
// violation so the browser tests can assert that the production Content-Security-Policy breaks nothing.
window.__cspViolations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__cspViolations.push(`${event.effectiveDirective || event.violatedDirective} ${event.blockedURI || "inline"}`);
});
