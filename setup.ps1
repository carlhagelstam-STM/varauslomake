# STM Varauslomake -- kertaalleen ajettava asennus tälle koneelle.
# Aja tämä TÄSSÄ kansiossa (Documents\STM-Varauslomake) kertaalleen per kone.
# Klikkaa: hiiren oikea painike tälle tiedostolle -> "Suorita PowerShellillä"

$ErrorActionPreference = "Stop"

Write-Host "1/4: Tarkistetaan Node.js..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Node.js puuttuu tältä koneelta." -ForegroundColor Red
    Write-Host "Lataa ja asenna se osoitteesta: https://nodejs.org (valitse LTS-versio)"
    Write-Host "Kun asennus on valmis, sulje tämä ikkuna ja aja tämä scripti uudelleen."
    Read-Host "Paina Enter sulkeaksesi"
    exit 1
}
Write-Host "OK: Node.js löytyi ($(node --version))"

Write-Host ""
Write-Host "2/4: Asennetaan clasp (Apps Scriptin komentorivityökalu)..."
npm install -g @google/clasp

Write-Host ""
Write-Host "3/4: Kirjaudutaan Google-tilille (avautuu selainikkuna -- kirjaudu Tuulilasimestarien Google-tilillä)..."
clasp login

Write-Host ""
Write-Host "4/4: Haetaan Apps Script -koodi tähän kansioon (apps-script -alikansioon)..."
if (Test-Path ".\apps-script\.clasp.json") {
    Write-Host "Apps Script -koodi on jo tässä kansiossa (tuli GitHubista) -- ei haeta uudestaan."
} else {
    if (-not (Test-Path ".\apps-script")) {
        New-Item -ItemType Directory -Path ".\apps-script" | Out-Null
    }
    Set-Location ".\apps-script"
    clasp clone "10P4Ii7Yba5SlaW_onYjyGO_gInZgh5tJWca__g5ZEHU2PTLJO1ALCRHF"
    Set-Location ".."
}

Write-Host ""
Write-Host "VALMIS! Asennus onnistui." -ForegroundColor Green
Write-Host "Jatkossa käytä deploy.ps1 -tiedostoa (samassa kansiossa) kun haluat viedä muutokset livenä."
Read-Host "Paina Enter sulkeaksesi"
