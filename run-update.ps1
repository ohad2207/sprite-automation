$repo = "C:\Users\ohadm\Documents\sprite-automation"
Set-Location $repo

git pull --rebase

$ok = $false
for ($i = 1; $i -le 3; $i++) {
    node scripts/update-sprites.js
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Write-Host "Attempt $i failed."
    if ($i -lt 3) { Start-Sleep -Seconds 60 }
}
if (-not $ok) { exit 1 }

git add data/*.json
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host "No changes to commit."; exit 0 }

git commit -m "chore: auto-update sprite data"
git pull --rebase
git push
