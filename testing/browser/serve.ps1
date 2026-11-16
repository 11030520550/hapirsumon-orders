param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$TestDir = $PSScriptRoot,
  [int]$Port = 8000
)
# Local static server for manual checks + mocked browser tests.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File testing\browser\serve.ps1
# /            -> project files (html/css/js/png only; no .git, no data files)
# /__test/...  -> files from this testing/browser folder
# /__test/app.html -> project index.html with the Supabase CDN script replaced by a local mock
$ErrorActionPreference = "Stop"
$types = @{ ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".png" = "image/png"; ".svg" = "image/svg+xml"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg" }
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
    if ($path -eq "/__test/app.html" -or $path -eq "/__test/app-old.html") {
      $html = [IO.File]::ReadAllText((Join-Path $Root "index.html"), $utf8)
      $html = $html.Replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>', '<script src="/__test/mock-supabase.js"></script>')
      $html = $html -replace 'src="business-app\.js(\?v=[^"]*)?"', 'src="/business-app.js"'
      $html = ($html -replace 'href="styles\.css(\?v=[^"]*)?"', 'href="/styles.css"').Replace('src="supabase-config.js"', 'src="/supabase-config.js"').Replace('src="assets/', 'src="/assets/')
      if ($path -eq "/__test/app-old.html") {
        $html = ($html -replace 'src="app\.js(\?v=[^"]*)?"', 'src="/__test/old/app.js"') -replace 'src="business-preview\.js(\?v=[^"]*)?"', 'src="/__test/old/business-preview.js"'
      } else {
        $html = ($html -replace 'src="app\.js(\?v=[^"]*)?"', 'src="/app.js"') -replace 'src="business-preview\.js(\?v=[^"]*)?"', 'src="/business-preview.js"'
      }
      $bytes = $utf8.GetBytes($html); $type = $types[".html"]
    } else {
      if ($path.StartsWith("/__test/")) { $file = Join-Path $TestDir ($path.Substring(8) -replace '/', '\') }
      else { $file = Join-Path $Root ($path.TrimStart('/') -replace '/', '\') }
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      if (-not $types.ContainsKey($ext) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "notfound" }
      $bytes = [IO.File]::ReadAllBytes($file); $type = $types[$ext]
    }
    $res.StatusCode = 200
    $res.ContentType = $type
    $res.Headers.Add("Cache-Control", "no-store")
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    $res.StatusCode = 404
    $msg = $utf8.GetBytes("Not found")
    $res.OutputStream.Write($msg, 0, $msg.Length)
  } finally {
    $res.OutputStream.Close()
  }
}
