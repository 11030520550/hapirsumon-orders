param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$TestDir = $PSScriptRoot,
  [int]$Port = 8000,
  # Optional: a Netlify-style _headers file. Its "/*" headers (e.g. the CSP) are sent with the app pages and
  # files, and a CSP-violation recorder (/__test/csp-recorder.js) is injected into HTML pages, so tests run
  # under the same policy as production. Test runner pages under /__test/ (which use inline scripts) are exempt.
  [string]$HeadersFile = ""
)
# Local static server for manual checks + mocked browser tests.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File testing\browser\serve.ps1 [-HeadersFile _headers]
# /            -> project files (html/css/js/png only; no .git, no data files)
# /__test/...  -> files from this testing/browser folder
# /__test/app.html -> project index.html with the Supabase library replaced by a local mock
$ErrorActionPreference = "Stop"
$extraHeaders = [ordered]@{}
if ($HeadersFile) {
  $inBlock = $false
  foreach ($line in [IO.File]::ReadAllLines((Resolve-Path $HeadersFile).Path)) {
    if ($line -match '^\s*#' -or $line.Trim() -eq "") { continue }
    if ($line -match '^\S') { $inBlock = ($line.Trim() -eq "/*"); continue }
    if ($inBlock -and $line -match '^\s+([^:]+):\s*(.+)$') { $extraHeaders[$Matches[1].Trim()] = $Matches[2].Trim() }
  }
  Write-Output ("Sending {0} headers from {1}" -f $extraHeaders.Count, $HeadersFile)
}
$recorderTag = '<script src="/__test/csp-recorder.js"></script>'
$types = @{ ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".png" = "image/png"; ".svg" = "image/svg+xml"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"; ".wasm" = "application/wasm"; ".data" = "application/octet-stream"; ".sql" = "text/plain; charset=utf-8"; ".mjs" = "text/javascript; charset=utf-8"; ".json" = "application/json"; ".woff2" = "font/woff2"; ".webp" = "image/webp" }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serving $Root on http://127.0.0.1:$Port/"
$utf8 = New-Object System.Text.UTF8Encoding($false)
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }
    $bytes = $null; $type = $null
    if ($path -match '\.\.' -or $path -match '(^|/)\.') { throw "forbidden" }
    if ($path -eq "/__test/real.html") {
      # The real index.html (real supabase-js + real supabase-config.js), framable by same-origin test pages.
      $html = [IO.File]::ReadAllText((Join-Path $Root "index.html"), $utf8)
      $html = ($html -replace '(src|href)="(?!https?:|/|#|data:)', '$1="/')
      $bytes = $utf8.GetBytes($html); $type = $types[".html"]
    } elseif ($path -eq "/__test/app.html" -or $path -eq "/__test/app-old.html" -or $path -eq "/__test/app-preview.html") {
      $html = [IO.File]::ReadAllText((Join-Path $Root "index.html"), $utf8)
      $html = $html.Replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>', '<script src="/__test/mock-supabase.js"></script>')
      $html = $html -replace '<script src="vendor/supabase-js-[^"]+"[^>]*></script>', '<script src="/__test/mock-supabase.js"></script>'
      $html = $html -replace 'src="business-app\.js(\?v=[^"]*)?"', 'src="/business-app.js"'
      $html = ($html -replace 'href="styles\.css(\?v=[^"]*)?"', 'href="/styles.css"').Replace('src="supabase-config.js"', 'src="/supabase-config.js"').Replace('src="assets/', 'src="/assets/')
      if ($path -eq "/__test/app-old.html") {
        $html = ($html -replace 'src="app\.js(\?v=[^"]*)?"', 'src="/__test/old/app.js"') -replace 'src="business-preview\.js(\?v=[^"]*)?"', 'src="/__test/old/business-preview.js"'
      } else {
        $html = ($html -replace 'src="app\.js(\?v=[^"]*)?"', 'src="/app.js"') -replace 'src="business-preview\.js(\?v=[^"]*)?"', 'src="/business-preview.js"'
      }
      if ($path -eq "/__test/app-preview.html") {
        # The login screen no longer has the preview button; business-preview.js still binds to it if present.
        # Test-only: add a hidden entry button so runner-client.html can open the sample-data preview.
        $html = $html -replace '(<body[^>]*>)', '$1<button id="open-business-preview" type="button" hidden></button>'
      }
      $bytes = $utf8.GetBytes($html); $type = $types[".html"]
    } else {
      if ($path.StartsWith("/__test/")) { $file = Join-Path $TestDir ($path.Substring(8) -replace '/', '\') }
      else { $file = Join-Path $Root ($path.TrimStart('/') -replace '/', '\') }
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      if (-not $types.ContainsKey($ext) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "notfound" }
      $bytes = [IO.File]::ReadAllBytes($file); $type = $types[$ext]
    }
    $isAppPage = ($path -eq "/__test/app.html" -or $path -eq "/__test/real.html" -or $path -eq "/__test/app-preview.html")
    $isRunnerPage = $path.StartsWith("/__test/") -and -not $isAppPage
    if ($extraHeaders.Count -and -not $isRunnerPage -and $type -eq $types[".html"]) {
      $html = $utf8.GetString($bytes)
      $html = $html -replace '(<head[^>]*>)', ('$1' + $recorderTag)
      $bytes = $utf8.GetBytes($html)
    }
    $res.StatusCode = 200
    $res.ContentType = $type
    $res.Headers.Add("Cache-Control", "no-store")
    if ($extraHeaders.Count -and -not $isRunnerPage) {
      foreach ($k in $extraHeaders.Keys) {
        $value = $extraHeaders[$k]
        # The test runners embed /__test/app.html in a same-origin iframe; only for that page is framing relaxed
        # from 'none'/DENY to same-origin. Every other directive is sent exactly as in _headers.
        if ($isAppPage) {
          if ($k -eq "Content-Security-Policy") { $value = $value -replace "frame-ancestors 'none'", "frame-ancestors 'self'" }
          if ($k -eq "X-Frame-Options") { $value = "SAMEORIGIN" }
        }
        $res.Headers.Add($k, $value)
      }
    }
    # HEAD: headers and length only (writing a body to a HEAD response throws and used to crash the server).
    if ($ctx.Request.HttpMethod -eq "HEAD") { $res.ContentLength64 = $bytes.Length }
    else { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  } catch {
    try {
      $res.StatusCode = 404
      if ($ctx.Request.HttpMethod -ne "HEAD") { $msg = $utf8.GetBytes("Not found"); $res.OutputStream.Write($msg, 0, $msg.Length) }
    } catch { }
  } finally {
    try { $res.OutputStream.Close() } catch { }
  }
}
