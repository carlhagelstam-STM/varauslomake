# STM Varauslomake -- aja tämä AINA kun haluat viedä muutokset livenä.
# Klikkaa: hiiren oikea painike tälle tiedostolle -> "Suorita PowerShellillä"

$ErrorActionPreference = "Stop"
$deploymentId = "AKfycbwJD34dyJhcwvp0l2JDwCkB2cVgM2Ue9pWRYQ1jp9xh8z_k9maSv7bkt69ZJgfkc-pN"

Write-Host "1/4: Haetaan viimeisimmät muutokset GitHubista..."
git pull

Write-Host ""
Write-Host "2/4: Viedään Koodi.gs Apps Scriptiin..."
Set-Location ".\apps-script"
clasp push -f

Write-Host ""
Write-Host "3/4: Otetaan uusi versio käyttöön (sama osoite pysyy samana kuin ennenkin)..."
clasp deploy -i $deploymentId -d "Deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Set-Location ".."

Write-Host ""
Write-Host "4/4: Viedään muut tiedostomuutokset (lomakkeet) GitHubiin..."
git add -A
$hasChanges = git status --porcelain
if ($hasChanges) {
    $msg = Read-Host "Kirjoita lyhyt kuvaus mitä muutit (tai paina vain Enter)"
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "Paivitys $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    git commit -m $msg
    git push
    Write-Host "Valmis! Kaikki muutokset ovat nyt livenä." -ForegroundColor Green
} else {
    Write-Host "Ei lomakemuutoksia -- vain Apps Script päivittyi." -ForegroundColor Yellow
}
Read-Host "Paina Enter sulkeaksesi"
