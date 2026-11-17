Set-Location C:\Users\ohadm\Documents\sprite-automation
git pull --rebase
node scripts\update-sprites.js
if ($LASTEXITCODE -ne 0) { exit 1 }
if (git status --porcelain data) {
git add data
git commit -m “Update sprite data”
git push
}