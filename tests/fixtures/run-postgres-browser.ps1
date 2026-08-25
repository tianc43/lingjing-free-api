$ErrorActionPreference = 'Stop'
$container = 'lingjing-postgres-browser'
$server = $null
try {
  docker rm -f $container 2>$null | Out-Null
  docker run -d --name $container -p 127.0.0.1:15432:5432 -e POSTGRES_USER=lingjing -e POSTGRES_PASSWORD=fixture-postgres -e POSTGRES_DB=lingjing postgres:16.6-alpine | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  do {
    docker exec $container pg_isready -U lingjing -d lingjing *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready' }
  $env:DATABASE_URL = 'postgres://lingjing:fixture-postgres@127.0.0.1:15432/lingjing'
  $server = Start-Process -FilePath 'node.exe' -ArgumentList '--import','tsx','tests/fixtures/postgres-browser-server.ts' -PassThru -NoNewWindow
  $deadline = (Get-Date).AddSeconds(30)
  do {
    try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18092/healthz' -TimeoutSec 2 } catch { $response = $null }
    if ($response -and $response.StatusCode -eq 200) { break }
    if ($server.HasExited) { throw "Browser server exited $($server.ExitCode)" }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if (-not $response) { throw 'Browser server did not become ready' }
  npx playwright test tests/browser/postgres-admin.browser.test.ts --reporter=line
  if ($LASTEXITCODE -ne 0) { throw "Playwright exited $LASTEXITCODE" }
} finally {
  if ($server -and -not $server.HasExited) { try { Invoke-WebRequest -UseBasicParsing -Method Post 'http://127.0.0.1:18093/__test/shutdown' -TimeoutSec 2 | Out-Null } catch {}; $server.WaitForExit(5000) | Out-Null; if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } }
  docker rm -f $container 2>$null | Out-Null
}
