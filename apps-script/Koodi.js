const KOODI_VERSIO = 'v21';

// UUSI 24.8.2026: lomakkeen omistajaTyyppi-arvot → Airtablen Asiakkaat-taulun
// 'asiakastyyppi'-valinnat. Kolme yritysmuotoista tyyppiä käsitellään samalla
// koodilla suoritaVarauksenTallennus-funktiossa; tämä kartta kertoo vain mikä
// arvo Airtableen kirjataan. 'yksityinen' EI ole tässä, koska sillä on oma
// haaransa (haku sähköpostilla, eri kentät).
// HUOM: arvojen on vastattava TÄSMÄLLEEN Airtablen valintalistan vaihtoehtoja
// kirjainkokoa myöten, muuten Airtable palauttaa INVALID_MULTIPLE_CHOICE_OPTIONS.
const ASIAKASTYYPPI_KARTTA = {
  'yritys':    'Yritys',
  'leasing':   'Leasing',
  'autoliike': 'Autoliike',
};
const KOODI_PAIVAYS = '2026-08-25';

// TIETOTURVAKORJAUS 25.8.2026: varmistaa heti alussa että Script Properties
// on asetettu, ennen kuin mikään Airtable-kutsu ehtii epäonnistua äänettömästi
// (ilman tätä puuttuva AIRTABLE_TOKEN näkyisi vain hämäränä 401-virheenä
// jokaisessa yksittäisessä Airtable-kutsussa, ei selkeänä alkuvirheenä).
function tarkistaVaadititutAsetukset() {
  if (!AIRTABLE_TOKEN) {
    throw new Error(
      'AIRTABLE_TOKEN puuttuu Script Propertiesista. Aseta se: ' +
      'Apps Script -editori -> asetusrattaan vieressä Project Settings -> ' +
      'Script Properties -> Add script property (Nimi: AIRTABLE_TOKEN).'
    );
  }
}

// TIETOTURVAKORJAUS 25.8.2026: yksinkertainen rate limiting palvelunesto-
// hyökkäyksiä vastaan. Apps Script Web App ei anna suoraa pääsyä pyytäjän
// IP-osoitteeseen, joten rajoitus tehdää koko sovellukselle yhteisesti:
// jos pyyntöjä tulee lyhyessä ajassa enemmän kuin RATE_LIMIT_RAJA, uudet
// pyynnöt hylätään selkeällä virheellä sen sijaan että Airtable/Drive-kutsut
// kuormittuisivat rajattomasti. CacheService on jaettu kaikkien saman
// deploymentin kutsujen kesken, sopii tähän hyvin.
const RATE_LIMIT_IKKUNA_S = 60;   // aikaikkuna sekunteina
const RATE_LIMIT_RAJA     = 120;  // sallittu pyyntömäärä ikkunan aikana

function tarkistaPyyntoRaja() {
  try {
    const cache = CacheService.getScriptCache();
    const avain = 'rl_' + Math.floor(Date.now() / (RATE_LIMIT_IKKUNA_S * 1000));
    const nykyinen = Number(cache.get(avain)) || 0;
    if (nykyinen >= RATE_LIMIT_RAJA) {
      return false;
    }
    cache.put(avain, String(nykyinen + 1), RATE_LIMIT_IKKUNA_S + 5);
    return true;
  } catch (e) {
    // Jos välimuisti ei jostain syystä toimi, ei estetä palvelua kokonaan —
    // rate limiting on lisäsuoja, ei ainoa suoja.
    Logger.log('Rate limit -tarkistus epäonnistui (ei kriittistä): ' + e.message);
    return true;
  }
}

// ═══════════════════════════════════════════════════════════
// SUORITUSKYKYLOKI 21.9.2026: Carl raportoi ajoittaista hitautta ilman
// selkeää yksittäistä syytä. Tämän sijaan että arvataan mikä on hidas,
// KAIKKI palvelinpyynnöt (sekä doGet että doPost) kirjataan nyt automaattisesti
// yhteen Google Sheet -tiedostoon: kesto millisekunteina, onnistuiko, ja
// mahdollinen virheviesti. Tätä ei tarvitse asentaa erikseen — ensimmäisellä
// suorituskerralla luodaan sheet nimeltä "STM Suorituskykyloki" automaattisesti
// omistajan (skriptin ajajan) Google Driveen, ja sen ID tallennetaan Script
// Propertiesiin uudelleenkäyttöä varten.
//
// TÄRKEÄÄ: lokitus EI SAA KOSKAAN näkyä käyttäjälle hitautena tai virheenä.
// Siksi koko lokitus on try/catchin sisällä ja epäonnistuminen vain
// kirjataan Apps Scriptin omaan suoritushistoriaan (ei näy lomakkeella).
// Jos loki kasvaa isoksi (>5000 riviä), vanhimmat rivit karsitaan pois
// automaattisesti, jottei sheet itsessään ala hidastaa lokitusta.
//
// Alkuperäiset doGet/doPost-funktiot on nimetty uudelleen (doGetSisainen /
// doPostSisainen) ja niiden edelle on lisätty ohut "wrapper", joka mittaa
// ajan ja kirjaa rivin — mikään yksittäinen action-haara ei muutu.
const SUORITUSKYKYLOKI_OTSIKKO = ['Aikaleima', 'Suunta', 'Toiminto', 'Kesto (ms)', 'Tila', 'Virhe'];
const SUORITUSKYKYLOKI_MAX_RIVIA = 5000;

// KORJAUS 22.9.2026: aiemmin tämä loi "STM Suorituskykyloki" -sheetin
// LENNOSTA ensimmäisen pyynnön yhteydessä (SpreadsheetApp.create()), mikä
// on huomattavasti hitaampi kuin tavallinen appendRow olemassa olevaan
// sheettiin. Todennäköinen syy 22.9.2026 havaittuun "Tarra-virhe:
// Unexpected token '<'"-virheeseen: itse tarra tallentui Driveen oikein,
// mutta juuri tämä ensimmäinen SpreadsheetApp.create()-kutsu (joka
// suoritetaan JOKAISEN pyynnön lopuksi, tämän lokituksen ansiosta) venytti
// vastausaikaa niin paljon että selain/Google katkaisi yhteyden ennen kuin
// varsinainen JSON-vastaus ehti perille — käyttäjälle näkyi HTML-virhesivu,
// vaikka data oli jo tallessa.
//
// Nyt sheetin AUTOMAATTINEN luonti on poistettu pyynnön käsittelystä
// kokonaan: kirjaaSuoritusloki lukee vain valmiiksi olemassa olevan sheetin,
// ja jos sitä ei vielä ole, se yksinkertaisesti ei kirjaa mitään (ei
// koskaan aiheuta viivettä tai virhettä oikealle pyynnölle). Sheet luodaan
// KERRAN käsin Apps Script -editorista ajamalla luoSuorituskykylokiKerran().
function haeSuorituskykySheet() {
  const props = PropertiesService.getScriptProperties();
  const tallennettuId = props.getProperty('SUORITUSKYKYLOKI_SHEET_ID');
  if (!tallennettuId) return null;
  try {
    return SpreadsheetApp.openById(tallennettuId).getSheets()[0];
  } catch (avausVirhe) {
    Logger.log('Suorituskykylokin tallennettu sheet-ID ei toiminut: ' + avausVirhe.message);
    return null;
  }
}

// KÄSIN AJETTAVA ASETUSFUNKTIO — aja tämä KERRAN Apps Script -editorissa
// (▶-nappi), ei koskaan verkkopyynnön yhteydessä. Luo sheetin rauhassa,
// ilman että kenenkään oikea pyyntö odottaa sitä.
function luoSuorituskykylokiKerran() {
  const olemassaOleva = haeSuorituskykySheet();
  if (olemassaOleva) {
    Logger.log('Suorituskykyloki on jo olemassa, ei luoda uutta.');
    return 'Sheet on jo olemassa.';
  }
  const uusiTiedosto = SpreadsheetApp.create('STM Suorituskykyloki');
  const lehti = uusiTiedosto.getSheets()[0];
  lehti.setName('Loki');
  lehti.appendRow(SUORITUSKYKYLOKI_OTSIKKO);
  lehti.setFrozenRows(1);
  PropertiesService.getScriptProperties().setProperty('SUORITUSKYKYLOKI_SHEET_ID', uusiTiedosto.getId());
  Logger.log('Uusi suorituskykyloki luotu: ' + uusiTiedosto.getUrl());
  return uusiTiedosto.getUrl();
}

function kirjaaSuoritusloki(suunta, action, kestoMs, ok, virheteksti) {
  try {
    const lehti = haeSuorituskykySheet();
    if (!lehti) return; // Sheettiä ei ole vielä luotu käsin — ei kirjata, ei viivytetä pyyntöä.
    lehti.appendRow([
      new Date(),
      suunta,
      action || '(tuntematon)',
      kestoMs,
      ok ? 'OK' : 'VIRHE',
      virheteksti || ''
    ]);
    const rivimaara = lehti.getLastRow();
    if (rivimaara > SUORITUSKYKYLOKI_MAX_RIVIA) {
      lehti.deleteRows(2, rivimaara - SUORITUSKYKYLOKI_MAX_RIVIA); // rivi 1 = otsikko
    }
  } catch (lokiVirhe) {
    Logger.log('Suorituskykylokin kirjaus epäonnistui (ei kriittistä): ' + lokiVirhe.message);
  }
}

// Yhteinen ajastin+lokitin sekä doGetille että doPostille — kutsuu varsinaista
// käsittelijää (doGetSisainen/doPostSisainen), mittaa keston ja kirjaa rivin,
// palauttaen käsittelijän vastauksen muuttumattomana eteenpäin.
function suoritaJaLokitaPyynto(suunta, kasittelijaFn, e) {
  const alkuAika = Date.now();
  const action = (e && e.parameter && e.parameter.action) || '(tuntematon)';
  let tulos;
  try {
    tulos = kasittelijaFn(e);
  } catch (poikkeus) {
    kirjaaSuoritusloki(suunta, action, Date.now() - alkuAika, false, 'Poikkeus: ' + poikkeus.message);
    throw poikkeus;
  }
  let ok = true;
  let virhe = '';
  try {
    const data = JSON.parse(tulos.getContent());
    ok = data.ok !== false;
    if (!ok) virhe = data.error || '';
  } catch (jasennysVirhe) {
    // Vastaus ei ollut JSONia (harvinaista) — ei kaadeta lokitusta tämän takia.
  }
  kirjaaSuoritusloki(suunta, action, Date.now() - alkuAika, ok, virhe);
  return tulos;
}

function doGet(e) {
  return suoritaJaLokitaPyynto('GET', doGetSisainen, e);
}

function doPost(e) {
  return suoritaJaLokitaPyynto('POST', doPostSisainen, e);
}

function doGetSisainen(e) {
  try {
    tarkistaVaadititutAsetukset();
    if (!tarkistaPyyntoRaja()) {
      return jsonVastaus({ ok: false, error: 'Liikaa pyyntöjä lyhyessä ajassa. Yritä hetken kuluttua uudelleen.' });
    }
    const action = (e.parameter && e.parameter.action) || '';

    if (action === 'versio') {
      return jsonVastaus({
        ok: true,
        versio: KOODI_VERSIO,
        paivays: KOODI_PAIVAYS,
        actioneita: 35,
        aika: Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd HH:mm')
      });
    }

    if (action === 'haeSallitutPisteet') {
      const tunnus = e.parameter.istunto || e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(tunnus);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut.' });
      }
      const pisteet = haeSallitutPisteetLopullinen(email);
      return jsonVastaus({ ok: true, pisteet: pisteet });
    }

    if (action === 'haeMuisti') {
      const tunnus = e.parameter.istunto || e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(tunnus);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut.' });
      }
      return jsonVastaus({
        ok: true,
        toimittajat: haeToimittajat(),
        omavastuut: haeOmavastuut(),
        vakuutusJarjestys: haeVakuutusJarjestys()
      });
    }

    if (action === 'haeAuto') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const rekisteri = e.parameter.rekisteri || '';
      if (!rekisteri) {
        return ContentService
          .createTextOutput(JSON.stringify({ ok: false, error: 'Rekisterinumero puuttuu' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const auto = airtableGet(TABLE_AUTOT, `{rekisterinumero}="${kaavaTeksti(rekisteri)}"`);

      if (auto) {
        const fields = auto.fields;
        let eurokoodi = '';
        const lasitIds = fields['Lasit'] || [];
        if (lasitIds.length > 0) {
          const lasiUrl = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_LASIT}/${lasitIds[0]}`;
          const lasiResp = UrlFetchApp.fetch(lasiUrl, {
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
            muteHttpExceptions: true
          });
          const lasiData = JSON.parse(lasiResp.getContentText());
          eurokoodi = lasiData.fields ? (lasiData.fields['eurokoodi'] || '') : '';
        }

        return ContentService
          .createTextOutput(JSON.stringify({
            ok: true,
            auto: {
              'vin-tunniste': fields['vin-tunniste'] || '',
              'rekisterinumero': fields['rekisterinumero'] || '',
              'merkki': fields['merkki'] || '',
              'malli': fields['malli'] || '',
              'vuosimalli': fields['vuosimalli'] || '',
              'eurokoodi': eurokoodi,
            }
          }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService
          .createTextOutput(JSON.stringify({ ok: false, error: 'Autoa ei löydy' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (action === 'haeOmatOikeudet') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({
          ok: false,
          istuntoVanhentunut: true,
          error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.'
        });
      }

      const pisteet = haeSallitutPisteetLopullinen(email);
      if (pisteet === null) {
        return jsonVastaus({
          ok: false,
          istuntoVanhentunut: false,
          error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')'
        });
      }

      const henkilo = haeHenkiloEmaililla(email);
      const asentajaLinkit = (henkilo && henkilo.fields['Asentajat']) || [];

      return jsonVastaus({
        ok: true,
        email: email,
        pisteet: pisteet,
        admin: onkoAdminLopullinen(email),
        varauskeskus: onkoOikeus(email, 'varauskeskus'),
        asentaja: Array.isArray(asentajaLinkit) && asentajaLinkit.length > 0,
      });
    }

    if (action === 'haeAsentajaTyot') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const pisteet = haeSallitutPisteetLopullinen(email);
      if (pisteet === null) {
        return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')' });
      }

      const tanaan = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');
      const alku = e.parameter.alku || tanaan;
      const loppu = e.parameter.loppu || alku;

      const pisteEhdot = pisteet.map(p => `{asennuspiste/location}="${kaavaTeksti(p)}"`).join(',');
      // TIETOTURVAKORJAUS 25.8.2026: alku/loppu ajettu kaavaTeksti():n läpi
      // ennen kaavaan liittämistä, samasta syystä kuin haeVaraukset-toiminnossa.
      const formula = `AND(OR(${pisteEhdot}), IS_AFTER({päivämäärä}, DATEADD(DATETIME_PARSE("${kaavaTeksti(alku)}"), -1, 'days')), IS_BEFORE({päivämäärä}, DATEADD(DATETIME_PARSE("${kaavaTeksti(loppu)}"), 1, 'days')))`;
      const records = airtableList(TABLE_TYOTILAUKSET, formula, 'päivämäärä', 'asc');
      const tyyppiKestotById = haeTyotyyppiKestot(); // UUSI 13.7.2026 — tyyppi on nyt linkkikenttä, ei teksti

      const tyot = records.map(r => ({
        id:            r.id,
        varausnumero:  r.fields['varausnumero'] || '',
        asiakaskoodi:  r.fields['asiakaskoodi'] || '',
        piste:         r.fields['asennuspiste/location'] || '',
        paivamaara:    r.fields['päivämäärä'] || '',
        kellonaika:    r.fields['kellonaika'] || '',
        tyyppi:        muotoileTyotyyppiLinkki(r.fields['tyyppi'], tyyppiKestotById, true),
        tila:          r.fields['tila'] || '',
        rekisteri:     r.fields['rekisterinumero'] || '',
        merkki:        (r.fields['Merkki (auto)'] || [])[0] || '',
        malli:         (r.fields['Malli (auto)'] || [])[0] || '',
        eurokoodi:     (r.fields['Eurokoodi (auto)'] || [])[0] || '',
        lisatiedot:    r.fields['Lisätiedot'] || '',
        // UUSI 24.8.2026: autoliike- ja yritystiedot asentajalle.
        // Asentajan on tiedettävä kenen auto on kyseessä ja keneltä se
        // noudetaan — erityisesti autoliiketöissä, joissa auto haetaan
        // liikkeestä eikä asiakas ole paikalla.
        //
        // Yrityksen nimi ja asiakastyyppi tulevat Airtablen lookup-kentistä
        // (lisätty 24.8.2026), eivät erillisellä API-kutsulla — muuten tähän
        // tulisi yksi kutsu per työ ja päivänäkymä hidastuisi tuntuvasti.
        // Kenttänimet vastaavat niitä joita asentaja.html jo odottaa — sivu on
        // rakennettu näiden varaan, mutta palvelin ei ole koskaan lähettänyt
        // niitä, joten lisätietolista on ollut tuotannossa tyhjä.
        yritys:             ensimmainenLookupArvo(r.fields['Yrityksen nimi (asiakas)']),
        asiakastyyppi:      ensimmainenLookupArvo(r.fields['Asiakastyyppi (asiakas)']),
        tyomaarays:         r.fields['Työmääräysnumero'] || '',
        myyja:              r.fields['Autoliikkeen yhteyshenkilö'] || '',
        kuljettajaNimi:     r.fields['Kuljettajan nimi'] || '',
        kuljettajaPuhelin:  r.fields['Kuljettajan puhelin'] || '',
        yhteyshenkiloEmail: r.fields['Yhteyshenkilön sähköposti'] || '',
        tarvikkeet:         r.fields['Tarvikkeet'] || '',
        hinta:              (r.fields['Hinta'] === undefined || r.fields['Hinta'] === null) ? '' : r.fields['Hinta'],
        tehdytTarkastukset: (r.fields['tila'] === 'Työn alla') ? haeTehdytTarkastukset(r.id) : [],
        // KORJAUS 16.9.2026: palvelin ei aiemmin palauttanut Kuvat-linkkiä
        // ollenkaan, vaikka se kirjoitetaan Airtableen kuvien tallennuksen
        // yhteydessä (ks. kasitteleKuvienTallennus). Seurauksena asentajan
        // selain luotti VAIN omaan muistinvaraiseen tyo.kuvatTallennettu
        // -lippuunsa, joka häviää aina kun sivu ladataan uudelleen — vaikka
        // kuvat olisivat jo tallessa Drivessa. Tämä esti "Valmis"-napin
        // väärin perustein jos sivu ehti latautua uudelleen kuvien oton ja
        // työn valmiiksi merkinnän välissä. Nyt frontend voi tarkistaa
        // tämän palvelimelta eikä vain selaimen omasta muistista.
        kuvatLinkki:        r.fields['Kuvat'] || '',
      }));

      return jsonVastaus({ ok: true, tyot: tyot });
    }

    if (action === 'aloitaTyo') {
      const token = e.parameter.token || '';
      const id = e.parameter.id || '';

      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const pisteet = haeSallitutPisteetLopullinen(email);
      if (pisteet === null) {
        return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')' });
      }

      if (!id) {
        return jsonVastaus({ ok: false, error: 'Työn id puuttuu' });
      }

      const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, id);
      if (!tyoRecord) {
        return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });
      }
      const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
      if (!pisteet.includes(tyoPiste)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
      }

      if (tyoRecord.fields['tila'] === 'Valmis') {
        return jsonVastaus({
          ok: false,
          error: 'Työ on jo merkitty valmiiksi eikä sitä voi aloittaa uudelleen. ' +
                 'Jos kyseessä on virhe, vaihda tila ensin varauskeskuksesta.'
        });
      }

      const paivitetty = airtablePatch(TABLE_TYOTILAUKSET, id, { 'tila': 'Työn alla' });
      if (paivitetty && paivitetty.id) {
        lisaaMuokkausHistoriaan(id, email, 'Aloitti työn');

        const tarkastusRaaka = e.parameter.tarkastukset || '';
        if (tarkastusRaaka) {
          tallennaAlkutarkastus(id, email, tarkastusRaaka);
        }

        return jsonVastaus({ ok: true, id: paivitetty.id, tila: 'Työn alla' });
      } else {
        return jsonVastaus({ ok: false, error: 'Päivitys epäonnistui' });
      }
    }

    if (action === 'merkitseValmiiksi') {
      const token = e.parameter.token || '';
      const id = e.parameter.id || '';

      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const pisteet = haeSallitutPisteetLopullinen(email);
      if (pisteet === null) {
        return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')' });
      }

      if (!id) {
        return jsonVastaus({ ok: false, error: 'Työn id puuttuu' });
      }

      const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, id);
      if (!tyoRecord) {
        return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });
      }
      const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
      if (!pisteet.includes(tyoPiste)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
      }

      // KORJAUS 18.9.2026: idempotenssi-suoja + lukko. Ilman tätä sama työ pystyi
      // laukaisemaan "Merkitse valmiiksi" -toiminnon kahdesti (esim. tuplaklikkaus,
      // hidas verkko + uusi yritys, tai kaksi lähes samanaikaista pyyntöä), jolloin
      // koko laskutusrutiini (Fennoa-luonnos, vakuutus-PDF, Finvoice, vakuutusyhtiön
      // Fennoa-luonnos) ajettiin uudestaan ja syntyi duplikaattilaskuja (havaittu
      // STM-2026-V00185:ssä). LockService varmistaa, ettei kaksi lähes yhtäaikaista
      // pyyntöä pääse molemmat ohittamaan tila==='Valmis'-tarkistusta ennen kuin
      // kumpikaan on ehtinyt kirjoittaa Airtableen. Lukko vapautetaan heti tilan
      // päivityksen jälkeen — itse laskutuslogiikka (ulkoiset API-kutsut) ei odota
      // lukon takana, koska se veisi turhaan aikaa muilta pyynnöiltä.
      const valmiiksiLukko = LockService.getScriptLock();
      try {
        valmiiksiLukko.waitLock(15000);
      } catch (lukkoVirhe) {
        Logger.log('Merkitse valmiiksi -lukkoa ei saatu 15 s:ssa työlle ' + id + ': ' + lukkoVirhe.message);
      }

      let paivitetty;
      let jouduttiinToistamaan = false;
      try {
        const tuoreTyoRecord = airtableGetById(TABLE_TYOTILAUKSET, id) || tyoRecord;
        if (tuoreTyoRecord.fields['tila'] === 'Valmis') {
          jouduttiinToistamaan = true;
        } else {
          paivitetty = airtablePatch(TABLE_TYOTILAUKSET, id, { 'tila': 'Valmis' });
        }
      } finally {
        try { valmiiksiLukko.releaseLock(); } catch (e) {}
      }

      if (jouduttiinToistamaan) {
        return jsonVastaus({
          ok: true,
          id: id,
          tila: 'Valmis',
          huomio: 'Työ oli jo merkitty valmiiksi aiemmin — laskutusta ei ajettu uudelleen (duplikaattien esto).'
        });
      }

      if (paivitetty && paivitetty.id) {
        lisaaMuokkausHistoriaan(id, email, 'Merkitsi työn valmiiksi');

        // VÄLIAIKAINEN RATKAISU 6.9.2026: yritetään luoda Fennoa-luonnos
        // heti kun työ merkitään valmiiksi. TÄMÄ ON TARKOITUKSELLA
        // VÄLIAIKAINEN — korvataan myöhemmin Laskurivit-rakenteella, jossa
        // lasku lähtee vasta "Tarkistettu"-tilassa (ks. muisti 6.9.2026),
        // koska rivejä voi silloin vielä lisätä jälkikäteen. Nyt tehdään
        // yksinkertainen versio: vain jos työllä on Asiakas EIKÄ
        // vakuutustapausta (vakuutustapaukset menevät Innovoice/Finvoice-
        // reittiä, ei Fennoaan — ks. luoFinvoiceXml).
        //
        // TÄRKEÄÄ: Fennoa-lähetyksen epäonnistuminen EI SAA estää työn
        // merkitsemistä valmiiksi — asentaja/varauskeskus ei saa jäädä
        // jumiin puuttuvien laskutustietojen takia. Virhe vain kirjataan.
        let fennoaVaroitus = '';
        try {
          // KORJAUS 18.9.2026: aiemmin tämä oli if/else-if — samalle
          // työlle syntyi VAIN Fennoa-lasku TAI vakuutus-PDF, ei koskaan
          // molempia. Todellisuudessa yhdellä työllä voi olla rivejä
          // molemmille maksajille (esim. vakuutusyhtiö maksaa lasin,
          // asiakas maksaa omavastuun/sulan itse) — nämä kaksi reittiä
          // ratkaistaan nyt TOISISTAAN RIIPPUMATTA, sen mukaan löytyykö
          // työltä kummallekin osoitettuja Laskurivit-rivejä.
          const onkoAsiakas = (tyoRecord.fields['Asiakas'] || []).length > 0;
          const onkoVakuutustapaus = !!haeVakuutustapausTyolle(id);
          const kaikkiRivit = haeKaikkiLaskurivitTyolle(id);
          const eiVakuutusRivit = kaikkiRivit.filter(r => r.fields['Maksaja'] !== 'Vakuutusyhtiö');
          const vakuutusRivit = kaikkiRivit.filter(r => r.fields['Maksaja'] === 'Vakuutusyhtiö');

          if (onkoAsiakas && eiVakuutusRivit.length > 0) {
            const fennoaTulos = lahetaFennoaLasku(id);
            if (fennoaTulos.ok) {
              lisaaMuokkausHistoriaan(id, email, 'Fennoa-luonnos luotu automaattisesti (VÄLIAIKAINEN: korvataan Laskurivit-rakenteella)');
            } else {
              fennoaVaroitus = 'Fennoa-luonnosta ei saatu luotua: ' + fennoaTulos.error;
              lisaaMuokkausHistoriaan(id, email, '⚠️ ' + fennoaVaroitus);
            }
          }

          if (onkoVakuutustapaus && vakuutusRivit.length > 0) {
            // VAKUUTUS-PDF + FINVOICE 17.–18.9.2026: kumpikaan ei lähde
            // minnekään automaattisesti (ei operaattoria kytkettynä) —
            // molemmat vain tallennetaan Google Driveen odottamaan.
            try {
              const pdfTulos = luoVakuutusPdf(id);
              if (pdfTulos.ok) {
                lisaaMuokkausHistoriaan(id, email, '📄 Vakuutuslasku (PDF) tallennettu Driveen: ' + pdfTulos.tiedostonimi);
              } else {
                lisaaMuokkausHistoriaan(id, email, '⚠️ Vakuutuslaskun PDF:n luonti epäonnistui: ' + pdfTulos.error);
              }
            } catch (pdfErr) {
              lisaaMuokkausHistoriaan(id, email, '⚠️ Vakuutuslaskun PDF:n luonti epäonnistui: ' + pdfErr.message);
            }
            try {
              const finvoiceTulos = luoVakuutusFinvoice(id);
              if (finvoiceTulos.ok) {
                lisaaMuokkausHistoriaan(id, email, '📄 Finvoice-tiedosto tallennettu Driveen: ' + finvoiceTulos.tiedostonimi);
              } else {
                lisaaMuokkausHistoriaan(id, email, '⚠️ Finvoice-tiedoston luonti epäonnistui: ' + finvoiceTulos.error);
              }
            } catch (finvoiceErr) {
              lisaaMuokkausHistoriaan(id, email, '⚠️ Finvoice-tiedoston luonti epäonnistui: ' + finvoiceErr.message);
            }
            // VAKUUTUSYHTIÖN FENNOA-LUONNOS 18.9.2026: jää luonnokseksi
            // Fennoaan (ei hyväksytä, ei lähetetä) — Carl vahvisti että
            // sekä asiakkaan että vakuutusyhtiön lasku saavat toistaiseksi
            // jäädä luonnokseksi, ei tarvitse vielä ratkaista oikeaa
            // delivery_method-arvoa "lähetetään käsin" -tilalle.
            try {
              const vakFennoaTulos = luoVakuutusFennoaLasku(id);
              if (vakFennoaTulos.ok) {
                lisaaMuokkausHistoriaan(id, email, '🧾 Vakuutusyhtiön Fennoa-luonnos luotu automaattisesti');
              } else {
                lisaaMuokkausHistoriaan(id, email, '⚠️ Vakuutusyhtiön Fennoa-luonnoksen luonti epäonnistui: ' + vakFennoaTulos.error);
              }
            } catch (vakFennoaErr) {
              lisaaMuokkausHistoriaan(id, email, '⚠️ Vakuutusyhtiön Fennoa-luonnoksen luonti epäonnistui: ' + vakFennoaErr.message);
            }
          }
        } catch (fennoaErr) {
          fennoaVaroitus = 'Fennoa-luonnoksen yritys epäonnistui: ' + fennoaErr.message;
          lisaaMuokkausHistoriaan(id, email, '⚠️ ' + fennoaVaroitus);
        }

        return jsonVastaus({ ok: true, id: paivitetty.id, tila: 'Valmis', fennoaVaroitus: fennoaVaroitus });
      } else {
        return jsonVastaus({ ok: false, error: 'Päivitys epäonnistui' });
      }
    }

    if (action === 'haeKayttajalista') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei admin-oikeutta tällä tilillä (' + email + ')' });
      }
      return jsonVastaus({ ok: true, users: haeKayttajatAirtablesta() });
    }

    if (action === 'haeRoolit') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei admin-oikeutta tällä tilillä (' + email + ')' });
      }

      const rivit = airtableListAll(TABLE_ROOLIT, 'TRUE()', 'Nimi', 'asc');
      const roolit = rivit
        .map(r => ({ id: r.id, nimi: r.fields['Nimi'] || '' }))
        .filter(r => r.nimi);

      return jsonVastaus({ ok: true, roolit: roolit });
    }

    if (action === 'haeVaraukset') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta varauskeskusnäkymään (' + email + ')' });
      }

      const alku = e.parameter.alku || '';
      const loppu = e.parameter.loppu || '';
      const tilaSuodatin = e.parameter.tilaSuodatin || '';

      const ehdot = [];
      if (alku && loppu) {
        // TIETOTURVAKORJAUS 25.8.2026: alku/loppu ajettu kaavaTeksti():n läpi
        // ennen kaavaan liittämistä — nämä tulevat suoraan URL-parametrista
        // eivätkä olleet aiemmin siivottuja, jolloin käyttäjä (jolla on
        // varauskeskus-oikeus) olisi voinut rikkoa tai muokata koko
        // filterByFormula-lauseketta.
        ehdot.push(`IS_AFTER({päivämäärä}, DATEADD(DATETIME_PARSE("${kaavaTeksti(alku)}"), -1, 'days')), IS_BEFORE({päivämäärä}, DATEADD(DATETIME_PARSE("${kaavaTeksti(loppu)}"), 1, 'days'))`);
      }
      if (tilaSuodatin) {
        ehdot.push(`{tila}="${kaavaTeksti(tilaSuodatin)}"`);
      }
      const formula = ehdot.length > 0 ? `AND(${ehdot.join(',')})` : 'TRUE()';

      const records = airtableListAll(TABLE_TYOTILAUKSET, formula, 'päivämäärä', 'desc');
      const tyyppiKestotById = haeTyotyyppiKestot();
      const varaukset = records.map(r => peruskentatVarauksesta(r, tyyppiKestotById));

      return jsonVastaus({ ok: true, varaukset: varaukset });
    }

    if (action === 'haeVarausLisatiedot') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta varauskeskusnäkymään (' + email + ')' });
      }
      const id = e.parameter.id || '';
      if (!id) {
        return jsonVastaus({ ok: false, error: 'Varauksen id puuttuu' });
      }
      const record = airtableGetById(TABLE_TYOTILAUKSET, id);
      if (!record) {
        return jsonVastaus({ ok: false, error: 'Varausta ei löydy' });
      }
      const lisatiedot = haeYhdenVarauksenLisatiedot(record);
      return jsonVastaus({ ok: true, id: id, lisatiedot: lisatiedot });
    }

    if (action === 'haeLisatietoKooste') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta varauskeskusnäkymään (' + email + ')' });
      }
      const idLista = suodataRecordIdt((e.parameter.ids || '').split(','));
      if (idLista.length === 0) {
        return jsonVastaus({ ok: true, lisatiedot: {} });
      }

      const lisatiedot = haeLisatietoKoosteMonelle(idLista);
      return jsonVastaus({ ok: true, lisatiedot: lisatiedot });
    }

    if (action === 'haeOmatPisteet') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      const pisteet = haeSallitutPisteetLopullinen(email);
      if (pisteet === null) {
        return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')' });
      }
      return jsonVastaus({ ok: true, pisteet: pisteet });
    }

    if (action === 'haePisteJarjestys') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      const laite = (e.parameter.laite === 'mobile') ? 'mobile' : 'desktop';
      const kaikki = lueKaikkiPisteJarjestykset();
      const oma = kaikki[email.toLowerCase()];
      const jarjestys = (oma && Array.isArray(oma[laite])) ? oma[laite] : null;
      return jsonVastaus({ ok: true, jarjestys: jarjestys });
    }

    if (action === 'haeKapasiteetti') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta kapasiteettitietoon (' + email + ')' });
      }

      const piste = e.parameter.piste || '';
      const paivamaara = e.parameter.paivamaara || '';
      if (!piste) {
        return jsonVastaus({ ok: false, error: 'Piste puuttuu' });
      }
      if (!paivamaara) {
        return jsonVastaus({ ok: false, error: 'Päivämäärä puuttuu' });
      }

      const tulos = laskeKapasiteetti(piste, paivamaara);
      return jsonVastaus(tulos);
    }

    if (action === 'haePisteenViikko') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const piste = e.parameter.piste || '';
      if (!piste) {
        return jsonVastaus({ ok: false, error: 'Piste puuttuu' });
      }

      const sallitutPisteet = haeSallitutPisteetLopullinen(email);
      if (sallitutPisteet === null || !sallitutPisteet.includes(piste)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + piste + ')' });
      }

      const PAIVIA = 14;
      const alku = new Date();
      const paivaListat = [];
      for (let i = 0; i < PAIVIA; i++) {
        const d = new Date(alku.getFullYear(), alku.getMonth(), alku.getDate() + i);
        paivaListat.push({
          pvm: Utilities.formatDate(d, 'Europe/Helsinki', 'yyyy-MM-dd'),
          viikonpaiva: VIIKONPAIVAT[d.getDay()],
        });
      }
      const paivaStringit = paivaListat.map(p => p.pvm);

      const raja = (pvmStr, siirto) => {
        const [v, k, p] = pvmStr.split('-').map(Number);
        const d = new Date(v, k - 1, p + siirto);
        return Utilities.formatDate(d, 'Europe/Helsinki', 'yyyy-MM-dd');
      };
      esitaytaTyotJaksolle(raja(paivaStringit[0], -1), raja(paivaStringit[PAIVIA - 1], 1), paivaStringit);
      esitaytaSijoituksetJaksolle(raja(paivaStringit[0], -1), raja(paivaStringit[PAIVIA - 1], 1), paivaStringit);

      const asentajatKaikki = haeAktiivisetAsentajat();
      const lukituksetKaikki = haeKaikkiLukitukset();
      const tyyppiKestotKaikki = haeTyotyyppiKestot();

      const paivat = paivaListat.map(p => {
        const aukiolo = haeAukiolo(piste, p.pvm);
        const onkoAuki = !!(aukiolo && aukiolo.onkoAuki);

        if (!onkoAuki) {
          return {
            paivamaara: p.pvm,
            viikonpaiva: p.viikonpaiva,
            onkoAuki: false,
            aukeamisaika: (aukiolo && aukiolo.aukiKlo) || '',
            sulkeutumisaika: (aukiolo && aukiolo.kiinniKlo) || '',
            sarakkeet: [],
          };
        }

        const tulos = laskePisteenAikataulu(
          piste, p.pvm, haePaivanSijoitukset(p.pvm),
          asentajatKaikki, lukituksetKaikki, tyyppiKestotKaikki
        );

        return {
          paivamaara: p.pvm,
          viikonpaiva: p.viikonpaiva,
          onkoAuki: true,
          aukeamisaika: haePisteenAukiaika(piste, p.pvm),
          sulkeutumisaika: (aukiolo && aukiolo.kiinniKlo) || '',
          sarakkeet: (tulos && tulos.ok && tulos.sarakkeet) ? tulos.sarakkeet : [],
        };
      });

      const kestotNimella = {};
      Object.keys(tyyppiKestotKaikki).forEach(id => {
        const t = tyyppiKestotKaikki[id];
        if (t && t.nimi) {
          kestotNimella[t.nimi] = { kesto: t.kesto || 0, adasLisaaika: t.adasLisaaika || 0 };
        }
      });

      return jsonVastaus({ ok: true, piste: piste, paivat: paivat, tyyppiKestot: kestotNimella });
    }

    if (action === 'haeKapasiteettiLandingPage') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }
      if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
        return jsonVastaus({ ok: false, error: 'Ei oikeutta kapasiteettitietoon (' + email + ')' });
      }

      const paivamaara = e.parameter.paivamaara ||
        Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');

      const sijoituksetKaikki = haePaivanSijoitukset(paivamaara);

      const kaikkiAsentajatKaikki = haeAktiivisetAsentajat();
      const kaikkiLukituksetKaikki = haeKaikkiLukitukset();
      const tyyppiKestotByIdKaikki = haeTyotyyppiKestot();

      haePaivanTyotKaikkiPisteet(paivamaara);

      const pisteet = {};
      ALL_PISTEET.forEach(piste => {
        pisteet[piste] = laskePisteenAikataulu(
          piste, paivamaara, sijoituksetKaikki,
          kaikkiAsentajatKaikki, kaikkiLukituksetKaikki, tyyppiKestotByIdKaikki
        );
      });

      const puuttuvatResurssitSarakkeet = [];
      Object.keys(pisteet).forEach(pisteNimi => {
        const data = pisteet[pisteNimi];
        if (data && data.ok && Array.isArray(data.ylimaaraiset) && data.ylimaaraiset.length > 0) {
          puuttuvatResurssitSarakkeet.push({ piste: pisteNimi, tyot: data.ylimaaraiset });
        }
      });

      const sijoituksetUlos = sijoituksetKaikki.map(s => ({
        id: s.id,
        asentajaId: (s.fields['Asentaja'] || [])[0] || null,
        piste: (s.fields['Piste'] || [])[0] || null,
        ruutuja: s.fields['Ruutuja'] || 0,
        lukittu: s.fields['Lukittu'] === true,
      }));

      return jsonVastaus({
        ok: true,
        paivamaara: paivamaara,
        pisteet: pisteet,
        puuttuvatResurssitSarakkeet: puuttuvatResurssitSarakkeet,
        sijoitukset: sijoituksetUlos,
      });
    }

    if (action === 'haeYritys') {
      const ytunnus = (e.parameter.ytunnus || '').trim();
      if (!ytunnus) {
        return jsonVastaus({ ok: false, error: 'Y-tunnus puuttuu' });
      }

      try {
        const prhUrl = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=' + encodeURIComponent(ytunnus);
        const resp = UrlFetchApp.fetch(prhUrl, { muteHttpExceptions: true });
        const status = resp.getResponseCode();

        if (status !== 200) {
          return jsonVastaus({ ok: false, error: 'PRH-haku epäonnistui (' + status + ')' });
        }

        const data = JSON.parse(resp.getContentText());
        const companies = data.companies || [];

        if (companies.length === 0) {
          return jsonVastaus({ ok: false, error: 'Yritystä ei löytynyt' });
        }

        const yritys = companies[0];

        let nimi = '';
        const names = yritys.names || [];
        const nykyinenNimi = names.find(n => n.version === 1) || names[0];
        if (nykyinenNimi) nimi = nykyinenNimi.name || '';

        let katuosoite = '';
        let postinumero = '';
        let postitoimipaikka = '';
        const addresses = yritys.addresses || [];
        const os = addresses.find(a => a.type === 1) || addresses.find(a => a.type === 2) || addresses[0];
        if (os) {
          const kadunnimi = os.street || '';
          const talonumero = os.buildingNumber || '';
          katuosoite = (kadunnimi + ' ' + talonumero).trim();
          postinumero = os.postCode || '';
          const postOffices = os.postOffices || [];
          const suomenkielinen = postOffices.find(p => p.languageCode === '1') || postOffices[0];
          if (suomenkielinen) postitoimipaikka = suomenkielinen.city || '';
        }

        return jsonVastaus({
          ok: true,
          yritys: {
            nimi: nimi,
            ytunnus: (yritys.businessId && yritys.businessId.value) ? yritys.businessId.value : ytunnus,
            katuosoite: katuosoite,
            postinumero: postinumero,
            postitoimipaikka: postitoimipaikka
          }
        });

      } catch (err) {
        return jsonVastaus({ ok: false, error: 'Virhe PRH-haussa: ' + err.message });
      }
    }

    if (action === 'haeAsiakas') {
      // TIETOTURVAKORJAUS 25.8.2026: tästä puuttui kirjautumistarkistus
      // kokonaan — kuka tahansa webhook-URL:n tietävä pystyi hakemaan
      // asiakastietoja (nimi, osoite, sähköposti) pelkällä puhelinnumerolla
      // ilman kirjautumista. Kaikki muut haku-actionit tarkistavat tämän,
      // tästä se oli jäänyt puuttumaan.
      const asiakasHakuToken = e.parameter.token || '';
      const asiakasHakuEmail = haeKirjautuneenSahkoposti(asiakasHakuToken);
      if (!asiakasHakuEmail) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const asiakasnumero = (e.parameter.asiakasnumero || '').trim();
      const puhelin = (e.parameter.puhelin || '').trim();
      const sahkoposti = (e.parameter.sahkoposti || '').trim();

      function normalisoiPuhelinVertailuun(nro) {
        let p = (nro || '').replace(/[\s\-()]/g, '');
        if (p.startsWith('+358')) p = '0' + p.slice(4);
        else if (p.startsWith('358') && p.length > 8) p = '0' + p.slice(3);
        return p;
      }

      function muotoileAsiakasHaulle(record) {
        const f = record.fields;
        return {
          id: record.id,
          asiakasnumero: f['Asiakasnumero'] || '',
          etunimi: f['etunimi'] || '',
          sukunimi: f['sukunimi'] || '',
          puhelin: f['puhelin'] || '',
          sahkoposti: f['sähköposti'] || '',
          osoite: f['osoite'] || '',
          postinumero: f['postinumero'] || '',
          kaupunki: f['kaupunki'] || '',
          asiakastyyppi: f['asiakastyyppi'] || ''
        };
      }

      function haeAsiakasPuhelimella(hakuNro) {
        const kohde = normalisoiPuhelinVertailuun(hakuNro);
        if (!kohde) return null;
        const rivit = airtableListAll(TABLE_ASIAKKAAT, 'NOT({puhelin}="")', null, null);
        for (let i = 0; i < rivit.length; i++) {
          if (normalisoiPuhelinVertailuun(rivit[i].fields['puhelin']) === kohde) {
            return rivit[i];
          }
        }
        return null;
      }

      if (asiakasnumero) {
        const loytyi = airtableGet(TABLE_ASIAKKAAT, `{Asiakasnumero}="${kaavaTeksti(asiakasnumero)}"`);
        if (loytyi) {
          return jsonVastaus({ ok: true, taso: 'numero', asiakas: muotoileAsiakasHaulle(loytyi) });
        }
        return jsonVastaus({ ok: true, taso: 'ei_osumaa' });
      }

      const puhelinOsuma = puhelin ? haeAsiakasPuhelimella(puhelin) : null;
      const emailOsuma = sahkoposti ? airtableGet(TABLE_ASIAKKAAT, `{sähköposti}="${kaavaTeksti(sahkoposti)}"`) : null;

      if (!puhelinOsuma && !emailOsuma) {
        return jsonVastaus({ ok: true, taso: 'ei_osumaa' });
      }

      if (puhelinOsuma && emailOsuma && puhelinOsuma.id !== emailOsuma.id) {
        return jsonVastaus({ ok: true, taso: 'ristiriita' });
      }

      const osuma = puhelinOsuma || emailOsuma;
      return jsonVastaus({ ok: true, taso: 'yksi_osuma', asiakas: muotoileAsiakasHaulle(osuma) });
    }

    // LASKURIVIT 16.9.2026 — rivipohjainen laskutusrakenne. Yksi rivi per
    // laskutettava tuote/palvelu, ei per työ. Korvaa vaiheittain vanhan
    // laskeTyonKokonaishinta-mallin. Maksaja on AINA ihmisen valitsema,
    // ei koskaan automaattisesti pääteltävä (esim. sijaisauto/nouto voivat
    // mennä joko asiakkaalle tai vakuutusyhtiölle tapauskohtaisesti).
    if (action === 'haeLaskurivit') {
      const token = e.parameter.token || '';
      const email = haeKirjautuneenSahkoposti(token);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
      }

      const tyoId = e.parameter.tyoId || '';
      if (!RECORD_ID_MUOTO.test(tyoId)) {
        return jsonVastaus({ ok: false, error: 'Virheellinen työn tunniste.' });
      }

      // KORJAUS 21.9.2026: ARRAYJOIN({Työtilaus}) palauttaa linkitetyn
      // työtilausrivin NÄYTTÖNIMEN (esim. "STM-2026-V00166"), ei sen
      // record id:tä — FIND(tyoId, ...) ei siis KOSKAAN löytänyt mitään,
      // vaikka rivejä oikeasti olisi ollut. Sama bugi löydettiin ja
      // korjattiin jo laskutuspuolella 16.9.2026 (ks. haeKaikkiLaskurivitTyolle-
      // kommentti) — tämä webhook jäi silloin vielä korjaamatta.
      const rivit = haeKaikkiLaskurivitTyolle(tyoId);

      const laskurivit = rivit.map(r => ({
        id: r.id,
        nimike: r.fields['Nimike'] || '',
        maara: r.fields['Määrä'] || 1,
        yksikkohinta: r.fields['Yksikköhinta (alv 0%)'] || 0,
        alvProsentti: r.fields['ALV %'] || 25.5,
        maksaja: r.fields['Maksaja'] || '',
        lisatty: r.fields['Lisätty'] || '',
        lisaaja: r.fields['Lisääjä'] || '',
        lahde: r.fields['Lähde'] || '',
        laskutettu: r.fields['Laskutettu'] === true,
        laskuId: r.fields['Lasku-ID'] || '',
        maksettuPvm: r.fields['Maksettu pvm'] || '',
      }));

      return jsonVastaus({ ok: true, laskurivit: laskurivit });
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Tuntematon action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('doGet kaatui: ' + err.message + ' | stack: ' + (err.stack || '-'));
    return jsonVastaus({ ok: false, error: 'Palvelinvirhe: ' + err.message });
  }
}

// TIETOTURVAKORJAUS 25.8.2026: AIRTABLE_TOKEN luetaan nyt Script Propertiesista
// eikä ole enää kovakoodattuna. Aiemmin token näkyi suoraan tässä tiedostossa
// kaikille joilla on edes katseluoikeus Apps Script -projektiin, ja se antaa
// täyden luku/kirjoitusoikeuden koko Airtable-baseen (kaikki asiakas-, auto-
// ja vakuutustiedot). Aseta arvo kerran: Apps Script -editorissa
// Project Settings -> Script Properties -> Add script property
// Nimi: AIRTABLE_TOKEN, Arvo: (sama token joka oli tässä ennen).
const AIRTABLE_TOKEN   = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
const BASE_ID          = 'appSfmoyYRrzWpfFT';
const TABLE_TYOTILAUKSET = 'tblYFd95ApmjnMPJF';
const TABLE_ASIAKKAAT    = 'tblrumZrAvsi3ZCYE';
const TABLE_AUTOT        = 'tblqTVUvcXXUaBynj';
const TABLE_LASIT        = 'tblw1XSObPpWuejdq';
const TABLE_VAKUUTUSYHTIOT   = 'Vakuutusyhtiöt';
const TABLE_VAKUUTUSTAPAUKSET = 'Vakuutustapaukset';
const TABLE_PISTEET      = 'Pisteet';
const TABLE_AUKIOLOAJAT  = 'Aukioloajat';
const TABLE_TARKASTUKSET = 'Tarkastukset';
const TABLE_ASENTAJAT    = 'Asentajat';
const TABLE_TYOTYYPIT    = 'Työtyypit';
const TABLE_LUKITUKSET   = 'Lukitukset';
const TABLE_TOIMITTAJAT  = 'Toimittajat';
const TABLE_OMAVASTUUT   = 'Omavastuut';
const TABLE_VAKUUTUSJARJESTYS = 'Vakuutusyhtiöjärjestys';
const TABLE_HENKILOT = 'Henkilöt';
const TABLE_ROOLIT = 'Roolit'; // UUSI 3.8.2026 - roolinimien resoluutioon (ks. onkoRooliAirtablesta)
const TABLE_ASENTAJAN_SIJOITUKSET = 'Asentajan_Sijoitukset'; // UUSI 31.7.2026

const DRIVE_DATA_FOLDER    = '1e8PffMwPOYBuTjAdCDGrZ3Q-Sv-08N36';
const DRIVE_KUVAT_FOLDER   = '1DVFBOP1XJIoTcXbyLBMWp4k1ecOkKzIl';
const DRIVE_TARRAT_FOLDER  = '1SudYQqrPjP-urY1sPNJzpfnHJnXiLXpG';
const DRIVE_KAYTTAJAT_FILE = 'stm_kayttajat.json';
const DRIVE_ISTUNNOT_FILE  = 'stm_istunnot.json';
const ISTUNNON_KESTO_MS    = 8 * 60 * 60 * 1000;
const ALL_PISTEET = ['Hatanpää','Kuopio','Lahti','Lempäälä','Lielahti','Pirkkala','Vantaa','Ylöjärvi','TEST'];

// TIETOTURVAKORJAUS 25.8.2026: samasta syystä kuin AIRTABLE_TOKEN yllä.
// Aseta Script Propertiesiin: MESSTO_USERNAME ja MESSTO_PASSWORD.
const MESSTO_USERNAME = PropertiesService.getScriptProperties().getProperty('MESSTO_USERNAME');
const MESSTO_PASSWORD = PropertiesService.getScriptProperties().getProperty('MESSTO_PASSWORD');

function normalisoiPuhelinnumero(numero) {
  let n = (numero || '').replace(/\s+/g, '');
  if (n.startsWith('+')) {
    return n;
  }
  if (n.startsWith('358')) {
    return '+' + n;
  }
  if (n.startsWith('0')) {
    return '+358' + n.slice(1);
  }
  return n;
}

function lahetaSMS(numero, viesti) {
  const normalisoituNumero = normalisoiPuhelinnumero(numero);
  const params = {
    sms_username: MESSTO_USERNAME,
    sms_password: MESSTO_PASSWORD,
    sms_dest: normalisoituNumero,
    sms_text: viesti,
    encoding: 'utf-8'
  };
  const query = Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  const url = 'https://messto.com/send?' + query;

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const vastaus = resp.getContentText();
  Logger.log('MESSTO vastaus (numero ' + normalisoituNumero + '): ' + vastaus);
  return vastaus;
}

function numeroTaiNull(arvo) {
  const teksti = String(arvo === undefined || arvo === null ? '' : arvo)
    .replace(',', '.').replace(/\s/g, '').trim();
  if (!teksti) return null;
  const luku = parseFloat(teksti);
  return isFinite(luku) ? luku : null;
}

function kaavaTeksti(arvo) {
  return String(arvo === undefined || arvo === null ? '' : arvo)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

const RECORD_ID_MUOTO = /^rec[A-Za-z0-9]{14}$/;

function suodataRecordIdt(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map(id => String(id || '').trim())
    .filter(id => RECORD_ID_MUOTO.test(id));
}

function airtableGet(table, formula) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText());
  return data.records && data.records.length > 0 ? data.records[0] : null;
}

function airtablePost(table, fields) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  return tarkistaAirtableVastaus(resp, 'luonti', table);
}

// UUSI 24.8.2026: keskitetty vastauksen tarkistus kirjoituskutsuille.
//
// Taustaa — tämä on illan tärkein korjaus. airtablePost käytti
// muteHttpExceptions: true ja palautti Airtablen vastauksen sellaisenaan,
// myös virhevastauksen. Kun luonti epäonnistui, paluuarvo oli
// { error: {...} } ilman id-kenttää. Kutsuja teki `asiakasId = uusi.id`,
// sai undefinedin, jatkoi kuin mitään ei olisi tapahtunut, ja varaus
// tallentui ilman asiakasta.
//
// Konkreettinen seuraus: koodi kirjoitti Asiakkaat-tauluun kenttää
// 'Asiakasnumero', jota ei ollut olemassa. Airtable vastasi joka kerta
// UNKNOWN_FIELD_NAME, eikä yhtäkään uutta asiakasta syntynyt — ei
// yksityistä eikä yritystä. Vika ei näkynyt missään, koska yksityisasiakas
// yleensä löytyi sähköpostilla eikä sitä tarvinnut luoda.
//
// Nyt virhe pysäyttää suorituksen ja päätyy käyttäjälle asti selkokielisenä.
function tarkistaAirtableVastaus(resp, toiminto, table) {
  const koodi = resp.getResponseCode();
  const teksti = resp.getContentText();

  let data = null;
  try {
    data = JSON.parse(teksti);
  } catch (e) {
    throw new Error('Airtable palautti tulkitsemattoman vastauksen (' + toiminto +
      ', taulu ' + table + ', HTTP ' + koodi + '): ' + teksti.slice(0, 200));
  }

  if (koodi < 200 || koodi >= 300 || (data && data.error)) {
    const virhe = data && data.error;
    const tyyppi = (virhe && (virhe.type || virhe)) || 'tuntematon virhe';
    const viesti = (virhe && virhe.message) ? (': ' + virhe.message) : '';
    throw new Error('Airtable hylkäsi pyynnön (' + toiminto + ', taulu ' + table +
      ', HTTP ' + koodi + '): ' + tyyppi + viesti);
  }

  // Onnistuneessa vastauksessa on aina record id. Jos ei ole, jokin on
  // pielessä tavalla jota emme osanneet ennakoida — parempi pysähtyä kuin
  // jatkaa vajaalla tiedolla.
  if (!data || !data.id) {
    throw new Error('Airtable palautti vastauksen ilman record id:tä (' +
      toiminto + ', taulu ' + table + '): ' + teksti.slice(0, 200));
  }

  return data;
}

function airtablePatch(table, recordId, fields) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  return tarkistaAirtableVastaus(resp, 'päivitys', table);
}

function airtableDelete(table, recordId) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText());
}

function airtableList(table, formula, sortField, sortDirection) {
  let url = `https://api.airtable.com/v0/${BASE_ID}/${table}?filterByFormula=${encodeURIComponent(formula)}&pageSize=50`;
  if (sortField) {
    url += `&sort[0][field]=${encodeURIComponent(sortField)}&sort[0][direction]=${sortDirection || 'asc'}`;
  }
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText());
  return data.records || [];
}

function airtableListAll(table, formula, sortField, sortDirection) {
  let all = [];
  let offset = null;
  do {
    let url = `https://api.airtable.com/v0/${BASE_ID}/${table}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
    if (sortField) {
      url += `&sort[0][field]=${encodeURIComponent(sortField)}&sort[0][direction]=${sortDirection || 'asc'}`;
    }
    if (offset) url += `&offset=${offset}`;
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText());
    all = all.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return all;
}

// UUSI 24.8.2026: Airtablen lookup-kenttä palauttaa AINA taulukon, vaikka
// linkitettyjä rivejä olisi vain yksi. Sisältö vaihtelee lähdekentän tyypin
// mukaan: tekstikentästä tulee merkkijonoja, valintakentästä joko merkkijonoja
// tai {id, name}-olioita Airtablen version mukaan. Jos linkkiä ei ole, kenttä
// puuttuu kokonaan. Tämä normalisoi kaiken tuon yhdeksi merkkijonoksi.
function ensimmainenLookupArvo(arvo) {
  if (arvo === undefined || arvo === null) return '';
  const lista = Array.isArray(arvo) ? arvo : [arvo];
  for (let i = 0; i < lista.length; i++) {
    const alkio = lista[i];
    if (alkio === undefined || alkio === null) continue;
    if (typeof alkio === 'object') {
      if (alkio.name) return String(alkio.name);
      continue;
    }
    const teksti = String(alkio).trim();
    if (teksti) return teksti;
  }
  return '';
}

function airtableGetById(table, recordId) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}/${recordId}`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  return JSON.parse(resp.getContentText());
}

function peruskentatVarauksesta(r, tyyppiKestotById) {
  const f = r.fields;
  return {
    id:            r.id,
    varausnumero:  f['varausnumero'] || '',
    asiakaskoodi:  f['asiakaskoodi'] || '',
    piste:         f['asennuspiste/location'] || '',
    paivamaara:    f['päivämäärä'] || '',
    kellonaika:    f['kellonaika'] || '',
    tyyppi:        muotoileTyotyyppiLinkki(f['tyyppi'], tyyppiKestotById, true),
    tila:          f['tila'] || '',
    rekisteri:     f['rekisterinumero'] || '',
    lisatiedot:    f['Lisätiedot'] || '',
    laskunTarkistus: f['Laskun tarkistus'] === true,
    hinta:               f['Hinta'] || '',
    lisapalvelut:        muotoileTyotyyppiLinkki(f['Lisäpalvelut'], tyyppiKestotById, false),
    tarvikkeet:          f['Tarvikkeet'] || '',
    leasingYhtio:        f['Leasing-yhtiö'] || '',
    leasingSopimus:      f['Leasing-sopimusnumero'] || '',
    leasingLasiturva:    f['Leasing-lasiturva'] || '',
    kuljettajaNimi:      f['Kuljettajan nimi'] || '',
    kuljettajaPuhelin:   f['Kuljettajan puhelin'] || '',
    yhteyshenkiloEmail:  f['Yhteyshenkilön sähköposti'] || '',
    tyomaarays:          f['Työmääräysnumero'] || '',
    yhteyshenkilo:       f['Autoliikkeen yhteyshenkilö'] || '',
    muokkaushistoria:    f['Muokkaushistoria'] || '',
  };
}

function haeYhdenVarauksenLisatiedot(record) {
  const f = record.fields;

  let asiakas = null;
  const asiakasIds = f['Asiakas'] || [];
  if (asiakasIds.length > 0) {
    const asiakasRecord = airtableGetById(TABLE_ASIAKKAAT, asiakasIds[0]);
    if (asiakasRecord) asiakas = muotoileAsiakas(asiakasRecord.fields);
  }

  let auto = null;
  const autoIds = f['auto'] || [];
  if (autoIds.length > 0) {
    const autoRecord = airtableGetById(TABLE_AUTOT, autoIds[0]);
    if (autoRecord) {
      auto = muotoileAuto(autoRecord.fields);
      const lasitIds = autoRecord.fields['Lasit'] || [];
      if (lasitIds.length > 0) {
        const lasiRecord = airtableGetById(TABLE_LASIT, lasitIds[0]);
        if (lasiRecord) auto.eurokoodi = lasiRecord.fields['eurokoodi'] || '';
      }
    }
  }

  let vakuutus = null;
  const vakuutusFormula = `FIND("${record.id}", ARRAYJOIN({Työtilaus}))`;
  const vakuutusRivi = airtableGet(TABLE_VAKUUTUSTAPAUKSET, vakuutusFormula);
  if (vakuutusRivi) {
    vakuutus = muotoileVakuutus(vakuutusRivi.fields, vakuutusRivi.id);
    const vyIds = vakuutusRivi.fields['Vakuutusyhtiö'] || [];
    if (vyIds.length > 0) {
      const vyRecord = airtableGetById(TABLE_VAKUUTUSYHTIOT, vyIds[0]);
      if (vyRecord) vakuutus.yhtio = vyRecord.fields['yhtiön nimi'] || '';
    }
  }

  return { asiakas: asiakas, auto: auto, vakuutus: vakuutus };
}

function haeLisatietoKoosteMonelle(tyotilausIdLista) {
  const idEhdot = tyotilausIdLista.map(id => `RECORD_ID()="${id}"`).join(',');
  const tyotilausRivit = airtableListAll(TABLE_TYOTILAUKSET, `OR(${idEhdot})`, null, null);

  const asiakasIdSet = {};
  const autoIdSet = {};
  tyotilausRivit.forEach(r => {
    (r.fields['Asiakas'] || []).forEach(id => asiakasIdSet[id] = true);
    (r.fields['auto'] || []).forEach(id => autoIdSet[id] = true);
  });

  const kaikkiAsiakkaat = airtableListAll(TABLE_ASIAKKAAT, 'TRUE()', null, null);
  const kaikkiAutot = airtableListAll(TABLE_AUTOT, 'TRUE()', null, null);
  const kaikkiLasit = airtableListAll(TABLE_LASIT, 'TRUE()', null, null);
  const kaikkiVakuutusyhtiot = airtableListAll(TABLE_VAKUUTUSYHTIOT, 'TRUE()', null, null);
  const vakuutusEhdot = tyotilausIdLista.map(id => `FIND("${id}", ARRAYJOIN({Työtilaus}))`).join(',');
  const kaikkiVakuutustapaukset = airtableListAll(TABLE_VAKUUTUSTAPAUKSET, `OR(${vakuutusEhdot})`, null, null);

  const asiakasMap = {};
  kaikkiAsiakkaat.forEach(r => { if (asiakasIdSet[r.id]) asiakasMap[r.id] = r; });
  const autoMap = {};
  kaikkiAutot.forEach(r => { if (autoIdSet[r.id]) autoMap[r.id] = r; });
  const lasiMap = {};
  kaikkiLasit.forEach(r => { lasiMap[r.id] = r; });
  const vakuutusyhtioMap = {};
  kaikkiVakuutusyhtiot.forEach(r => { vakuutusyhtioMap[r.id] = r; });

  const vakuutusPerTyotilaus = {};
  kaikkiVakuutustapaukset.forEach(vt => {
    const linkit = vt.fields['Työtilaus'] || [];
    linkit.forEach(tyoId => { vakuutusPerTyotilaus[tyoId] = vt; });
  });

  const tulos = {};
  tyotilausRivit.forEach(r => {
    const f = r.fields;
    let asiakas = null;
    const asiakasIds = f['Asiakas'] || [];
    if (asiakasIds.length > 0 && asiakasMap[asiakasIds[0]]) {
      asiakas = muotoileAsiakas(asiakasMap[asiakasIds[0]].fields);
    }

    let auto = null;
    const autoIds = f['auto'] || [];
    if (autoIds.length > 0 && autoMap[autoIds[0]]) {
      const autoRecord = autoMap[autoIds[0]];
      auto = muotoileAuto(autoRecord.fields);
      const lasitIds = autoRecord.fields['Lasit'] || [];
      if (lasitIds.length > 0 && lasiMap[lasitIds[0]]) {
        auto.eurokoodi = lasiMap[lasitIds[0]].fields['eurokoodi'] || '';
      }
    }

    let vakuutus = null;
    const vakuutusRivi = vakuutusPerTyotilaus[r.id];
    if (vakuutusRivi) {
      vakuutus = muotoileVakuutus(vakuutusRivi.fields, vakuutusRivi.id);
      const vyIds = vakuutusRivi.fields['Vakuutusyhtiö'] || [];
      if (vyIds.length > 0 && vakuutusyhtioMap[vyIds[0]]) {
        vakuutus.yhtio = vakuutusyhtioMap[vyIds[0]].fields['yhtiön nimi'] || '';
      }
    }

    tulos[r.id] = { asiakas: asiakas, auto: auto, vakuutus: vakuutus };
  });

  return tulos;
}

function muotoileAsiakas(af) {
  return {
    asiakastyyppi:  af['asiakastyyppi'] || '',
    etunimi:        af['etunimi'] || '',
    sukunimi:       af['sukunimi'] || '',
    puhelin:        af['puhelin'] || '',
    sahkoposti:     af['sähköposti'] || '',
    osoite:         af['osoite'] || '',
    postinumero:    af['postinumero'] || '',
    kaupunki:       af['kaupunki'] || '',
    yritysNimi:     af['yrityksen nimi'] || '',
    ytunnus:        af['y-tunnus'] || '',
    laskutusosoite: af['laskutusosoite'] || '',
    verkkolasku:    af['verkkolaskuosoite'] || '',
  };
}
function muotoileAuto(uf) {
  return {
    vin:         uf['vin-tunniste'] || '',
    merkki:      uf['merkki'] || '',
    malli:       uf['malli'] || '',
    vuosimalli:  uf['vuosimalli'] || '',
  };
}
function muotoileVakuutus(vf, recordId) {
  return {
    id:             recordId || '',
    yhtio:          '',
    vahinkotunnus:  vf['Vahinkotunnus'] || '',
    vahinkopaiva:   vf['Vahinkopäivä'] || '',
    omavastuu:      vf['Omavastuu'] || '',
    tarkistettu:    vf['Vakuutus tarkistettu'] === true,
    laskutuslupatunnus: vf['Laskutuslupatunnus'] || '',
    lasiturva:          vf['Lasiturva voimassa'] || 'Ei tarkistettu',
    alvVahennyskelpoinen: vf['ALV-vähennyskelpoinen'] === true,
    tila:               vf['Tila'] || '',
  };
}

function jsonVastaus(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

const UUID_MUOTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function haeKirjautuneenSahkoposti(tunnus) {
  if (!tunnus) return null;
  if (UUID_MUOTO.test(tunnus)) {
    return tarkistaIstunto(tunnus);
  }
  try {
    const resp = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': 'Bearer ' + tunnus },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    return (data.email || '').toLowerCase() || null;
  } catch (e) {
    Logger.log('Tokenin tarkistus epäonnistui: ' + e.message);
    return null;
  }
}

const VALIMUISTI_KESTO_S = 600; // 10 minuuttia

var _pyyntoMuisti = {};

function valimuistista(avain, hakuFn, onkoJaettu) {
  if (Object.prototype.hasOwnProperty.call(_pyyntoMuisti, avain)) {
    return _pyyntoMuisti[avain];
  }

  if (onkoJaettu) {
    try {
      const raaka = CacheService.getScriptCache().get(avain);
      if (raaka) {
        const arvo = JSON.parse(raaka);
        _pyyntoMuisti[avain] = arvo;
        return arvo;
      }
    } catch (e) {
      Logger.log('Välimuistin luku epäonnistui (' + avain + '): ' + e.message);
    }
  }

  const arvo = hakuFn();
  _pyyntoMuisti[avain] = arvo;

  if (onkoJaettu) {
    try {
      CacheService.getScriptCache().put(avain, JSON.stringify(arvo), VALIMUISTI_KESTO_S);
    } catch (e) {
      Logger.log('Välimuistiin tallennus epäonnistui (' + avain + '): ' + e.message);
    }
  }
  return arvo;
}

function tyhjennaValimuisti() {
  try {
    CacheService.getScriptCache().removeAll([
      'v1_pisteet', 'v1_aukioloajat', 'v1_tyotyypit', 'v1_roolit', 'v1_adasosuus'
    ]);
    _pyyntoMuisti = {};
    Logger.log('Välimuisti tyhjennetty.');
    return 'Välimuisti tyhjennetty.';
  } catch (e) {
    Logger.log('Välimuistin tyhjennys epäonnistui: ' + e.message);
    return 'Virhe: ' + e.message;
  }
}

function haeTyotyyppiKestot() {
  return valimuistista('v1_tyotyypit', function() {
    const rivit = airtableListAll(TABLE_TYOTYYPIT, 'TRUE()', null, null);
    const kestot = {};
    rivit.forEach(r => {
      kestot[r.id] = {
        nimi: r.fields['Nimi'] || '',
        kesto: r.fields['Kesto (min)'] || 0,
        adasLisaaika: r.fields['ADAS-lisäaika (min)'] || 0,
        rowActionCode: r.fields['RowActionCode'] || '1120113'
      };
    });
    return kestot;
  }, true);
}

function haeAdasOsuusVaihdoista(vaihtoTyyppiId) {
  if (!vaihtoTyyppiId) return 0.5;
  return valimuistista('v1_adasosuus', function() {
    try {
      const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_TYOTILAUKSET)}`
        + `?filterByFormula=${encodeURIComponent(`FIND("${vaihtoTyyppiId}", ARRAYJOIN({tyyppi}))`)}`
        + `&pageSize=100`
        + `&sort[0][field]=${encodeURIComponent('päivämäärä')}&sort[0][direction]=desc`;
      const resp = UrlFetchApp.fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) return 0.5;
      const rivit = (JSON.parse(resp.getContentText()).records) || [];
      if (rivit.length < 10) return 0.5;
      const adasMaara = rivit.filter(r => r.fields['ADAS'] === true).length;
      return adasMaara / rivit.length;
    } catch (e) {
      Logger.log('ADAS-osuuden laskenta epäonnistui: ' + e.message);
      return 0.5;
    }
  }, true);
}

function laskeVaihtoKeskikesto(tyyppiKestotById) {
  let vaihtoId = null, vaihtoKesto = 70, adasLisaaika = 20;
  for (const id in tyyppiKestotById) {
    if (tyyppiKestotById[id].nimi === 'Vaihto') {
      vaihtoId = id;
      vaihtoKesto = tyyppiKestotById[id].kesto || 70;
      adasLisaaika = tyyppiKestotById[id].adasLisaaika || 20;
      break;
    }
  }
  const adasOsuus = haeAdasOsuusVaihdoista(vaihtoId);
  return adasOsuus * (vaihtoKesto + adasLisaaika) + (1 - adasOsuus) * vaihtoKesto;
}

function haeTyotyyppiId(nimi, tyyppiKestotById) {
  if (!nimi) return null;
  const loydetty = Object.keys(tyyppiKestotById).find(
    id => tyyppiKestotById[id].nimi === nimi
  );
  return loydetty || null;
}

function muotoileTyotyyppiLinkki(linkkiTaulukko, tyyppiKestotById, ensimmainenVain) {
  if (!linkkiTaulukko || linkkiTaulukko.length === 0) return '';
  const nimet = linkkiTaulukko
    .map(id => (tyyppiKestotById[id] || {}).nimi)
    .filter(Boolean);
  if (ensimmainenVain) return nimet[0] || '';
  return nimet.join(', ');
}

function laskeTyonKesto(tyoRecord, tyyppiKestotById) {
  let kokonaisKesto = 0;
  const tyyppiLinkit = tyoRecord.fields['tyyppi'] || [];
  const lisapalveluLinkit = tyoRecord.fields['Lisäpalvelut'] || [];
  const adasPaalla = tyoRecord.fields['ADAS'] === true;

  tyyppiLinkit.concat(lisapalveluLinkit).forEach(recordId => {
    const tiedot = tyyppiKestotById[recordId];
    if (!tiedot) return;
    kokonaisKesto += tiedot.kesto;
    if (adasPaalla) kokonaisKesto += tiedot.adasLisaaika;
  });
  return kokonaisKesto;
}

// LASKUTUS 26.8.2026: laskee työn TODELLISEN kokonaishinnan laskutusta
// varten. 'Hinta'-kenttä sisältää historiallisesti VAIN lisäpalvelujen
// hinnan (esim. Sulat) — päätyön hinta (lasi+asennus) syötetään erikseen
// kolmeen omaan kenttäänsä (Lasin hinta / Työn hinta / Tarvikkeiden hinta)
// + Kalibroinnin hinta. Nämä EIVÄT koskaan summaudu 'Hinta'-kenttään
// automaattisesti, joten kaikki suoraan 'Hinta'-kenttää käyttävä
// laskutuskoodi (luoFinvoiceXml, koostaFennoaLaskuData) aliarvioi laskun
// summan systemaattisesti aina kun päätyön hinta on täytetty erikseen.
//
// TÄRKEÄÄ: 'Hinta'-kenttää ITSEÄÄN ei muuteta millään muulla toiminnolla
// (varauskeskus.html, asentaja.html jne. käyttävät sitä yhä ennallaan
// omaan tarkoitukseensa) — tämä funktio on VAIN laskutuksen sisäinen
// apufunktio, kutsutaan ainoastaan laskun summaa muodostettaessa.
function laskeTyonKokonaishinta(tyoRecord) {
  const f = tyoRecord.fields;
  const lisapalvelutHinta = parseFloat(f['Hinta']) || 0;
  const lasinHinta = parseFloat(f['Lasin hinta']) || 0;
  const tyonHinta = parseFloat(f['Työn hinta']) || 0;
  const tarvikkeidenHinta = parseFloat(f['Tarvikkeiden hinta']) || 0;
  const kalibroinninHinta = parseFloat(f['Kalibroinnin hinta']) || 0;
  return lisapalvelutHinta + lasinHinta + tyonHinta + tarvikkeidenHinta + kalibroinninHinta;
}

function haePisteetNimestaIdksi() {
  return valimuistista('v1_pisteet', function() {
    const rivit = airtableListAll(TABLE_PISTEET, 'TRUE()', null, null);
    const kartta = {};
    rivit.forEach(r => {
      const nimi = r.fields['Nimi'] || '';
      if (nimi) kartta[nimi] = r.id;
    });
    return kartta;
  }, true);
}

function haePisteId(pisteNimi) {
  const kartta = haePisteetNimestaIdksi();
  return kartta[pisteNimi] || null;
}

function paivaValissa(paivaDate, alkuStr, loppuStr) {
  if (!alkuStr || !loppuStr) return false;
  const alku = new Date(alkuStr);
  const loppu = new Date(loppuStr);
  return paivaDate >= alku && paivaDate <= loppu;
}

function laskeKapasiteetti(pisteNimi, paivamaaraStr) {
  const pisteId = haePisteId(pisteNimi);
  if (!pisteId) {
    return { ok: false, error: 'Pistettä ei löytynyt: ' + pisteNimi };
  }
  const kohdePvm = new Date(paivamaaraStr);

  const kaikkiAsentajat = airtableListAll(TABLE_ASENTAJAT, `{tila}="Aktiivinen"`, null, null);
  const kaikkiLukitukset = airtableListAll(TABLE_LUKITUKSET, 'TRUE()', null, null);

  const paivanLukitukset = kaikkiLukitukset.filter(l =>
    paivaValissa(kohdePvm, l.fields['Alkupäivä'], l.fields['Loppupäivä'])
  );

  const poissaOlevatAsentajaId = {};
  paivanLukitukset.forEach(l => {
    if (l.fields['Tyyppi'] !== 'Poissaolo') return;
    const asentajaLinkki = l.fields['Asentaja'] || [];
    asentajaLinkki.forEach(id => poissaOlevatAsentajaId[id] = true);
  });

  const siirretytAsentajaId = {};
  paivanLukitukset.forEach(l => {
    if (l.fields['Tyyppi'] !== 'Siirto toiseen pisteeseen') return;
    const pisteLinkki = l.fields['Piste'] || [];
    if (!pisteLinkki.includes(pisteId)) return;
    const asentajaLinkki = l.fields['Asentaja'] || [];
    asentajaLinkki.forEach(id => siirretytAsentajaId[id] = true);
  });

  const kaytettavissaOlevatAsentajat = kaikkiAsentajat.filter(a => {
    const ensisijainenPisteLinkki = a.fields['Ensisijainen piste'] || [];
    const onEnsisijaisestiTaalla = ensisijainenPisteLinkki.includes(pisteId);
    const onSiirrettyTanne = !!siirretytAsentajaId[a.id];
    const onPoissa = !!poissaOlevatAsentajaId[a.id];

    if (onPoissa) return false;
    return onEnsisijaisestiTaalla || onSiirrettyTanne;
  });

  const kokonaisKapasiteetti = kaytettavissaOlevatAsentajat.reduce(
    (summa, a) => summa + (a.fields['Työaika (min)'] || 480), 0
  );

  const paivamaaraFormatoitu = Utilities.formatDate(kohdePvm, 'Europe/Helsinki', 'yyyy-MM-dd');
  const tyyppiKestotById = haeTyotyyppiKestot();
  // TIETOTURVAKORJAUS 25.8.2026: pisteNimi ajettu kaavaTeksti():n läpi.
  // Tulee viime kädessä e.parameter.piste:stä (haeKapasiteetti-action) —
  // vaikka piste tarkistetaan käyttäjän sallittujen pisteiden listalta ennen
  // tätä kutsua, kaavaan liitettävä arvo pitää silti aina siivota erikseen.
  const paivanTyot = airtableListAll(
    TABLE_TYOTILAUKSET,
    `AND({asennuspiste/location}="${kaavaTeksti(pisteNimi)}", IS_SAME({päivämäärä}, "${kaavaTeksti(paivamaaraFormatoitu)}", 'day'), {tila}!="Poikkeama")`,
    null, null
  );
  const varattuAika = paivanTyot.reduce(
    (summa, tyo) => summa + laskeTyonKesto(tyo, tyyppiKestotById), 0
  );

  return {
    ok: true,
    piste: pisteNimi,
    paivamaara: paivamaaraFormatoitu,
    asentajienMaara: kaytettavissaOlevatAsentajat.length,
    kokonaisKapasiteetti: kokonaisKapasiteetti,
    varattuAika: varattuAika,
    vapaaAika: kokonaisKapasiteetti - varattuAika,
    asentajat: kaytettavissaOlevatAsentajat.map(a => a.fields['nimi'] || '(nimetön)')
  };
}

function haeAukioloajatHakemisto() {
  return valimuistista('v1_aukioloajat', function() {
    const pisteIdNimeksi = {};
    const nimestaIdksi = haePisteetNimestaIdksi();
    Object.keys(nimestaIdksi).forEach(nimi => { pisteIdNimeksi[nimestaIdksi[nimi]] = nimi; });

    const rivit = airtableListAll(TABLE_AUKIOLOAJAT, 'TRUE()', null, null);
    const hakemisto = {};
    rivit.forEach(r => {
      const f = r.fields;
      const viikonpaiva = f['Viikonpäivä'] || '';
      if (!viikonpaiva) return;
      (f['Piste'] || []).forEach(pisteId => {
        const pisteNimi = pisteIdNimeksi[pisteId];
        if (!pisteNimi) return;
        hakemisto[pisteNimi + '|' + viikonpaiva] = {
          onkoAuki: f['Onko auki'] === true,
          aukiKlo: f['Auki klo'] || '',
          kiinniKlo: f['Kiinni klo'] || '',
        };
      });
    });
    return hakemisto;
  }, true);
}

function haeAukiolo(pisteNimi, paivamaaraStr) {
  try {
    const [vuosi, kk, pv] = paivamaaraStr.split('-').map(Number);
    const viikonpaiva = VIIKONPAIVAT[new Date(vuosi, kk - 1, pv).getDay()];
    return haeAukioloajatHakemisto()[pisteNimi + '|' + viikonpaiva] || null;
  } catch (e) {
    Logger.log('Aukiolon haku epäonnistui (' + pisteNimi + '): ' + e.message);
    return null;
  }
}

function haeAukiolonPituusTunteina(pisteNimi, paivamaaraStr) {
  const tiedot = haeAukiolo(pisteNimi, paivamaaraStr);
  if (!tiedot) return null;
  if (!tiedot.onkoAuki) return 0;
  if (!tiedot.aukiKlo || !tiedot.kiinniKlo) return null;

  const [aukiH, aukiM] = tiedot.aukiKlo.split(':').map(Number);
  const [kiinniH, kiinniM] = tiedot.kiinniKlo.split(':').map(Number);
  const aukiMin = (aukiH || 0) * 60 + (aukiM || 0);
  const kiinniMin = (kiinniH || 0) * 60 + (kiinniM || 0);
  return Math.max(0, (kiinniMin - aukiMin) / 60);
}

function laskePisteenAikataulu(pisteNimi, paivamaaraStr, sijoituksetKaikki, kaikkiAsentajatValmis, kaikkiLukituksetValmis, tyyppiKestotByIdValmis) {
  const pisteId = haePisteId(pisteNimi);
  if (!pisteId) {
    return { ok: false, error: 'Pistettä ei löytynyt: ' + pisteNimi };
  }
  const kohdePvm = new Date(paivamaaraStr);
  const paivamaaraFormatoitu = Utilities.formatDate(kohdePvm, 'Europe/Helsinki', 'yyyy-MM-dd');

  const kaikkiAsentajat = kaikkiAsentajatValmis || haeAktiivisetAsentajat();
  const kaikkiLukitukset = kaikkiLukituksetValmis || haeKaikkiLukitukset();

  const paivanLukitukset = kaikkiLukitukset.filter(l =>
    paivaValissa(kohdePvm, l.fields['Alkupäivä'], l.fields['Loppupäivä'])
  );

  const poissaOlevatAsentajaId = {};
  paivanLukitukset.forEach(l => {
    if (l.fields['Tyyppi'] !== 'Poissaolo') return;
    (l.fields['Asentaja'] || []).forEach(id => poissaOlevatAsentajaId[id] = true);
  });

  const siirretytAsentajaId = {};
  paivanLukitukset.forEach(l => {
    if (l.fields['Tyyppi'] !== 'Siirto toiseen pisteeseen') return;
    const pisteLinkki = l.fields['Piste'] || [];
    if (!pisteLinkki.includes(pisteId)) return;
    (l.fields['Asentaja'] || []).forEach(id => siirretytAsentajaId[id] = true);
  });

  const sijoitukset = sijoituksetKaikki || haePaivanSijoitukset(paivamaaraFormatoitu);

  const poisAnnetutRuudutPerAsentaja = {};
  sijoitukset.forEach(s => {
    (s.fields['Asentaja'] || []).forEach(id => {
      poisAnnetutRuudutPerAsentaja[id] = (poisAnnetutRuudutPerAsentaja[id] || 0) + (s.fields['Ruutuja'] || 0);
    });
  });

  const vierasRuudutPerAsentaja = {};
  sijoitukset.forEach(s => {
    const pisteLinkki = s.fields['Piste'] || [];
    if (!pisteLinkki.includes(pisteId)) return;
    (s.fields['Asentaja'] || []).forEach(id => {
      vierasRuudutPerAsentaja[id] = (vierasRuudutPerAsentaja[id] || 0) + (s.fields['Ruutuja'] || 0);
    });
  });

  const kotiAsentajat = kaikkiAsentajat.filter(a => {
    const ensisijainenPisteLinkki = a.fields['Ensisijainen piste'] || [];
    const onEnsisijaisestiTaalla = ensisijainenPisteLinkki.includes(pisteId);
    const onSiirrettyTanne = !!siirretytAsentajaId[a.id];
    const onPoissa = !!poissaOlevatAsentajaId[a.id];
    if (onPoissa) return false;
    return onEnsisijaisestiTaalla || onSiirrettyTanne;
  });

  const vierasAsentajaIdLista = Object.keys(vierasRuudutPerAsentaja).filter(id => {
    if (poissaOlevatAsentajaId[id]) return false;
    if (kotiAsentajat.some(a => a.id === id)) return false; // jo kotiasentajana, ei tuplana
    return true;
  });
  const vierasAsentajat = vierasAsentajaIdLista
    .map(id => kaikkiAsentajat.find(a => a.id === id))
    .filter(Boolean);

  const kaikkiSarakeAsentajat = kotiAsentajat.concat(vierasAsentajat);
  const sarakkeidenMaara = kaikkiSarakeAsentajat.length;

  const tyyppiKestotById = tyyppiKestotByIdValmis || haeTyotyyppiKestot();

  const TAUKOMINUUTIT = 60; // 30 min ruokatauko + 2 x 15 min kahvitauko

  const vaihtoKeskikesto = laskeVaihtoKeskikesto(tyyppiKestotById);

  const TAITOTASO_OFFSET = { 'Mestari': 1, 'Senior': 0, 'Junior': -1 };

  function haeBudjettiMinuutit(asentajaRecord, onKotiasentaja) {
    if (!onKotiasentaja) {
      return (vierasRuudutPerAsentaja[asentajaRecord.id] || 0) * 60;
    }
    const taso = asentajaRecord.fields['Kokemustaso'] || '';
    const tyoaikaMin = asentajaRecord.fields['Työaika (min)'] || 480;
    const nettoMin = Math.max(0, tyoaikaMin - TAUKOMINUUTIT);
    const referenssiSenior = Math.max(1, Math.floor(nettoMin / vaihtoKeskikesto));

    let kiintioLuku;
    if (taso === 'Uusi') {
      kiintioLuku = 2; // kiinteä, ei lasketa työajasta
    } else {
      const offset = TAITOTASO_OFFSET[taso] !== undefined ? TAITOTASO_OFFSET[taso] : 0;
      kiintioLuku = Math.max(0, referenssiSenior + offset);
    }

    const poisAnnetutMin = (poisAnnetutRuudutPerAsentaja[asentajaRecord.id] || 0) * 60;
    return Math.max(0, (kiintioLuku * vaihtoKeskikesto) - poisAnnetutMin);
  }
  const paivanTyotRaaka = haePaivanTyotKaikkiPisteet(paivamaaraFormatoitu)
    .filter(r => (r.fields['asennuspiste/location'] || '') === pisteNimi);

  function kellonaikaMinuutteina(kellonaika) {
    const osat = (kellonaika || '00:00').split(':').map(Number);
    return (osat[0] || 0) * 60 + (osat[1] || 0);
  }

  const paivanTyot = paivanTyotRaaka.map(r => {
    const kesto = laskeTyonKesto(r, tyyppiKestotById) || 60;
    const alkuMin = kellonaikaMinuutteina(r.fields['kellonaika']);
    return {
      id: r.id,
      kellonaika: r.fields['kellonaika'] || '',
      rekisteri: r.fields['rekisterinumero'] || '',
      tila: r.fields['tila'] || '',
      varausnumero: r.fields['varausnumero'] || '',
      tyyppi: muotoileTyotyyppiLinkki(r.fields['tyyppi'], tyyppiKestotById, true),
      kestoMin: kesto,
      alkuMin: alkuMin,
      loppuMin: alkuMin + kesto,
      lukittu: r.fields['Lukittu aika'] === true, // UUSI 31.7.2026
      asentajaId: (r.fields['Asentaja'] || [])[0] || null, // UUSI 31.7.2026
    };
  });

  const budjetitPerAsentaja = kaikkiSarakeAsentajat.map(a =>
    haeBudjettiMinuutit(a, kotiAsentajat.some(k => k.id === a.id))
  );
  const kaytettyjaMinuutteja = budjetitPerAsentaja.map(() => 0);

  const sijoitetutSarakkeisiin = [];
  const ylimaaraiset = [];

  paivanTyot.forEach(tyo => {
    if (tyo.asentajaId) {
      const sarakeIndex = kaikkiSarakeAsentajat.findIndex(a => a.id === tyo.asentajaId);
      if (sarakeIndex !== -1) {
        sijoitetutSarakkeisiin.push({ sarake: sarakeIndex, tyo: tyo });
        kaytettyjaMinuutteja[sarakeIndex] += tyo.kestoMin;
        return;
      }
      ylimaaraiset.push(tyo);
      return;
    }

    let sijoitettu = false;
    for (let i = 0; i < sarakkeidenMaara; i++) {
      if (kaytettyjaMinuutteja[i] + tyo.kestoMin <= budjetitPerAsentaja[i]) {
        kaytettyjaMinuutteja[i] += tyo.kestoMin;
        sijoitetutSarakkeisiin.push({ sarake: i, tyo: tyo });
        sijoitettu = true;
        break;
      }
    }
    if (!sijoitettu) ylimaaraiset.push(tyo);
  });

  const sarakkeetUlos = [];
  for (let i = 0; i < sarakkeidenMaara; i++) {
    const tamanSarakkeenTyot = sijoitetutSarakkeisiin
      .filter(s => s.sarake === i)
      .map(s => s.tyo)
      .sort((a, b) => a.alkuMin - b.alkuMin);
    const asentajaRecord = kaikkiSarakeAsentajat[i];
    const onKoti = kotiAsentajat.some(a => a.id === asentajaRecord.id);
    const budjettiMin = budjetitPerAsentaja[i];

    let kumulatiivinenMin = 0;
    let fitCount = 0;
    for (let j = 0; j < tamanSarakkeenTyot.length; j++) {
      const seuraava = kumulatiivinenMin + tamanSarakkeenTyot[j].kestoMin;
      if (seuraava > budjettiMin) break;
      kumulatiivinenMin = seuraava;
      fitCount++;
    }

    let kiintio;
    if (fitCount < tamanSarakkeenTyot.length) {
      kiintio = fitCount;
    } else {
      const jaljellaOleva = budjettiMin - kumulatiivinenMin;
      const ylimaaraisetVapaat = vaihtoKeskikesto > 0 ? Math.floor(jaljellaOleva / vaihtoKeskikesto) : 0;
      kiintio = fitCount + ylimaaraisetVapaat;
    }

    sarakkeetUlos.push({
      asentaja: (asentajaRecord && asentajaRecord.fields['nimi']) || ('Asentaja ' + (i + 1)),
      asentajaId: asentajaRecord ? asentajaRecord.id : null, // UUSI 31.7.2026
      onKotiasentaja: onKoti, // UUSI 31.7.2026
      patevyydet: (asentajaRecord && asentajaRecord.fields['Pätevyydet']) || [],
      ruutumaara: kiintio,
      tyot: tamanSarakkeenTyot,
      vapaidenRuutujenMaara: Math.max(0, kiintio - tamanSarakkeenTyot.length),
    });
  }

  return {
    ok: true,
    piste: pisteNimi,
    paivamaara: paivamaaraFormatoitu,
    sarakkeidenMaara: sarakkeidenMaara,
    sarakkeet: sarakkeetUlos,
    ylimaaraiset: ylimaaraiset.sort((a, b) => a.alkuMin - b.alkuMin),
    aukiolonPituusTunteina: haeAukiolonPituusTunteina(pisteNimi, paivamaaraFormatoitu),
    aukeamisaika: haePisteenAukiaika(pisteNimi, paivamaaraFormatoitu),
    ruutuvaliMin: Math.round(vaihtoKeskikesto),
  };
}

function haeAktiivisetAsentajat() {
  return valimuistista('asentajat_aktiiviset', function() {
    return airtableListAll(TABLE_ASENTAJAT, `{tila}="Aktiivinen"`, null, null);
  }, false);
}

function haeKaikkiLukitukset() {
  return valimuistista('lukitukset_kaikki', function() {
    return airtableListAll(TABLE_LUKITUKSET, 'TRUE()', null, null);
  }, false);
}

function haePaivanTyotKaikkiPisteet(paivamaaraStr) {
  return valimuistista('paivantyot_' + paivamaaraStr, function() {
    return airtableListAll(
      TABLE_TYOTILAUKSET,
      `AND(IS_SAME({päivämäärä}, "${paivamaaraStr}", 'day'), {tila}!="Poikkeama")`,
      'kellonaika', 'asc'
    );
  }, false);
}

function esitaytaTyotJaksolle(alkuPvmStr, loppuPvmStr, paivat) {
  const rivit = airtableListAll(
    TABLE_TYOTILAUKSET,
    `AND(IS_AFTER({päivämäärä}, "${alkuPvmStr}"), IS_BEFORE({päivämäärä}, "${loppuPvmStr}"), {tila}!="Poikkeama")`,
    'kellonaika', 'asc'
  );

  const paivittain = {};
  paivat.forEach(p => { paivittain[p] = []; });
  rivit.forEach(r => {
    const raaka = r.fields['päivämäärä'] || '';
    const pvm = String(raaka).slice(0, 10);
    if (paivittain[pvm]) paivittain[pvm].push(r);
  });

  paivat.forEach(p => { _pyyntoMuisti['paivantyot_' + p] = paivittain[p]; });
}

function esitaytaSijoituksetJaksolle(alkuPvmStr, loppuPvmStr, paivat) {
  let rivit = [];
  try {
    rivit = airtableListAll(
      TABLE_ASENTAJAN_SIJOITUKSET,
      `AND(IS_AFTER({Päivämäärä}, "${alkuPvmStr}"), IS_BEFORE({Päivämäärä}, "${loppuPvmStr}"))`,
      null, null
    );
  } catch (e) {
    Logger.log('Sijoitusten jaksohaku epäonnistui: ' + e.message);
  }

  const paivittain = {};
  paivat.forEach(p => { paivittain[p] = []; });
  rivit.forEach(r => {
    const pvm = String(r.fields['Päivämäärä'] || '').slice(0, 10);
    if (paivittain[pvm]) paivittain[pvm].push(r);
  });

  paivat.forEach(p => { _pyyntoMuisti['sijoitukset_' + p] = paivittain[p]; });
}

function haePaivanSijoitukset(paivamaaraStr) {
  return valimuistista('sijoitukset_' + paivamaaraStr, function() {
    try {
      return airtableListAll(
        TABLE_ASENTAJAN_SIJOITUKSET,
        `IS_SAME({Päivämäärä}, "${paivamaaraStr}", 'day')`,
        null, null
      );
    } catch (e) {
      Logger.log('Sijoitusten haku epäonnistui (' + paivamaaraStr + '): ' + e.message);
      return [];
    }
  }, false);
}

function lueIstuntoTiedosto() {
  try {
    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    const tiedostot = kansio.getFilesByName(DRIVE_ISTUNNOT_FILE);
    if (!tiedostot.hasNext()) return { tiedosto: null, istunnot: [] };
    const tiedosto = tiedostot.next();
    const data = JSON.parse(tiedosto.getBlob().getDataAsString());
    return { tiedosto: tiedosto, istunnot: Array.isArray(data) ? data : [] };
  } catch (e) {
    Logger.log('Istuntotiedoston luku epäonnistui: ' + e.message);
    return { tiedosto: null, istunnot: [] };
  }
}

function tallennaIstuntoTiedosto(tiedosto, istunnot) {
  const sisalto = JSON.stringify(istunnot, null, 2);
  if (tiedosto) {
    tiedosto.setContent(sisalto);
  } else {
    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    kansio.createFile(DRIVE_ISTUNNOT_FILE, sisalto, MimeType.PLAIN_TEXT);
  }
}

function luoIstunto(email) {
  const istuntoId = Utilities.getUuid();
  const nyt = Date.now();

  const lukko = LockService.getScriptLock();
  try {
    lukko.waitLock(10000);
  } catch (e) {
    Logger.log('Istuntolukkoa ei saatu 10 s:ssa, jatketaan ilman: ' + e.message);
  }

  try {
    const { tiedosto, istunnot } = lueIstuntoTiedosto();

    const voimassaOlevat = istunnot.filter(function(i) {
      return (nyt - i.luotu) < ISTUNNON_KESTO_MS;
    });
    voimassaOlevat.push({ istuntoId: istuntoId, email: email, luotu: nyt });

    tallennaIstuntoTiedosto(tiedosto, voimassaOlevat);
    Logger.log('Istunto luotu: ' + istuntoId + ' (' + email + ')');
    return istuntoId;
  } finally {
    try { lukko.releaseLock(); } catch (e) {}
  }
}

// NOPEUTUS 17.9.2026: tämä funktio lukee istunnot Drivesta, mikä on hidas
// toimenpide (usein 1-3s), ja sitä kutsutaan JOKAISESSA kirjautuneessa
// pyynnössä koko sovelluksessa (haeKirjautuneenSahkoposti-kautta, 38
// paikassa). Välimuistitetaan tulos muutamaksi minuutiksi istunto-id:n
// perusteella (valimuistista-apufunktio, jaettu CacheService-välimuisti,
// oletuksena 10 min). Istunto on muutenkin voimassa 8h, joten muutaman
// minuutin viive vanhenemisen huomaamisessa on turvallista — järjestelmässä
// ei myöskään ole erillistä palvelinpuolista uloskirjautumista, joten
// tämä ei koskaan estä ketään kirjautumasta ulos nopeammin kuin ennenkään.
function tarkistaIstunto(istuntoId) {
  if (!istuntoId) return null;
  return valimuistista('istunto_' + istuntoId, function() {
    const { istunnot } = lueIstuntoTiedosto();
    const nyt = Date.now();
    const loydetty = istunnot.find(function(i) {
      return i.istuntoId === istuntoId;
    });
    if (!loydetty) return null;
    if ((nyt - loydetty.luotu) >= ISTUNNON_KESTO_MS) return null;
    return loydetty.email || null;
  }, true);
}

function lueKayttajaLista() {
  try {
    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    const tiedostot = kansio.getFilesByName(DRIVE_KAYTTAJAT_FILE);
    if (!tiedostot.hasNext()) return [];
    const tiedosto = tiedostot.next();
    const data = JSON.parse(tiedosto.getBlob().getDataAsString());
    return Array.isArray(data) ? data : [];
  } catch (e) {
    Logger.log('Käyttäjälistan luku epäonnistui: ' + e.message);
    return [];
  }
}

const DRIVE_PISTEJARJESTYS_FILE = 'stm_pistejarjestys.json';

function lueKaikkiPisteJarjestykset() {
  try {
    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    const tiedostot = kansio.getFilesByName(DRIVE_PISTEJARJESTYS_FILE);
    if (!tiedostot.hasNext()) return {};
    const tiedosto = tiedostot.next();
    const data = JSON.parse(tiedosto.getBlob().getDataAsString());
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    Logger.log('Pistejärjestysten luku epäonnistui: ' + e.message);
    return {};
  }
}

function tallennaKaikkiPisteJarjestykset(kaikki) {
  const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
  const tiedostot = kansio.getFilesByName(DRIVE_PISTEJARJESTYS_FILE);
  const sisalto = JSON.stringify(kaikki, null, 2);
  if (tiedostot.hasNext()) {
    tiedostot.next().setContent(sisalto);
  } else {
    kansio.createFile(DRIVE_PISTEJARJESTYS_FILE, sisalto, MimeType.PLAIN_TEXT);
  }
}

function kasittelePisteJarjestyksenTallennus(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';

    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }

    const laite = (body.laite === 'mobile') ? 'mobile' : 'desktop';
    const jarjestys = Array.isArray(body.jarjestys) ? body.jarjestys : null;
    if (!jarjestys) {
      return jsonVastaus({ ok: false, error: 'Järjestys puuttuu tai on virheellinen' });
    }

    const kaikki = lueKaikkiPisteJarjestykset();
    const emailAvain = email.toLowerCase();
    if (!kaikki[emailAvain]) kaikki[emailAvain] = {};
    kaikki[emailAvain][laite] = jarjestys;

    tallennaKaikkiPisteJarjestykset(kaikki);
    Logger.log('Pistejärjestys tallennettu (' + email + ', ' + laite + '): ' + JSON.stringify(jarjestys));
    return jsonVastaus({ ok: true });

  } catch (err) {
    Logger.log('Pistejärjestyksen tallennus epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kellonaikaMinuutteinaGlobaali(kellonaika) {
  const osat = (kellonaika || '00:00').split(':').map(Number);
  return (osat[0] || 0) * 60 + (osat[1] || 0);
}

function minuutitKellonajaksi(minuutit) {
  const h = Math.floor(minuutit / 60) % 24;
  const m = ((minuutit % 60) + 60) % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function haePisteenAukiaika(pisteNimi, paivamaaraStr) {
  const tiedot = haeAukiolo(pisteNimi, paivamaaraStr);
  if (tiedot && tiedot.onkoAuki && tiedot.aukiKlo) return tiedot.aukiKlo;
  return '08:00';
}

// PÄIVITETTY 25.8.2026 (Carlin pyyntö): "Työn alla" -tilassa olevaa työtä
// ei saa enää siirtää tästä toiminnosta (koko sarakkeen uudelleenjärjestely).
// Aiemmin eiSaaMuokata tarkisti vain lukitun kellonajan ja "Valmis"-tilan;
// "Työn alla" -työt liikkuivat siis vapaasti raahauksessa vaikka asentaja
// oli jo aloittanut työn. Nyt "Työn alla" käyttäytyy samoin kuin "Valmis":
// työ pysyy paikallaan, muut työt asettuvat sen ympärille kellonajan mukaan.
// Sama esto lisätty myös kasitteleTyonSiirtoRuutuun-funktioon, ja
// frontendissä kapasiteetti.html:n luoTyoSlot ei enää tee näistä raahattavia.
function kasitteleTyoJarjestely(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata kapasiteettia (' + email + ')' });
    }

    const piste = body.piste || '';
    const paivamaara = body.paivamaara || '';
    const kohdeAsentajaId = body.kohdeAsentajaId || '';
    const tyoIdJarjestys = Array.isArray(body.tyoIdJarjestys) ? body.tyoIdJarjestys : [];

    if (!piste || !paivamaara || !kohdeAsentajaId) {
      return jsonVastaus({ ok: false, error: 'Piste, päivämäärä tai kohdeasentaja puuttuu' });
    }

    const pisteet = haeSallitutPisteetLopullinen(email);
    if (pisteet === null || !pisteet.includes(piste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän pisteeseen (' + piste + ')' });
    }

    let kello = haePisteenAukiaika(piste, paivamaara);
    const tyyppiKestotById = haeTyotyyppiKestot();

    const paivanTyotById = {};
    haePaivanTyotKaikkiPisteet(paivamaara).forEach(r => { paivanTyotById[r.id] = r; });

    tyoIdJarjestys.forEach(tyoId => {
      const tyoRecord = paivanTyotById[tyoId] || airtableGetById(TABLE_TYOTILAUKSET, tyoId);
      if (!tyoRecord) return;

      const kesto = laskeTyonKesto(tyoRecord, tyyppiKestotById) || 60;
      const onLukittu = tyoRecord.fields['Lukittu aika'] === true;
      const eiSaaMuokata = onLukittu || tyoRecord.fields['tila'] === 'Valmis' || tyoRecord.fields['tila'] === 'Työn alla';

      const nykyinenAsentaja = (tyoRecord.fields['Asentaja'] || [])[0] || null;
      const omaKellonaika = tyoRecord.fields['kellonaika'] || '';
      const onSiirtoToiselta = nykyinenAsentaja !== kohdeAsentajaId && !!omaKellonaika;

      if (eiSaaMuokata) {
        const omaAlku = kellonaikaMinuutteinaGlobaali(omaKellonaika);
        const nykyinenKelloMin = kellonaikaMinuutteinaGlobaali(kello);
        kello = minuutitKellonajaksi(Math.max(nykyinenKelloMin, omaAlku + kesto));
      } else if (onSiirtoToiselta) {
        airtablePatch(TABLE_TYOTILAUKSET, tyoId, { 'Asentaja': [kohdeAsentajaId] });
        const omaAlku = kellonaikaMinuutteinaGlobaali(omaKellonaika);
        const nykyinenKelloMin = kellonaikaMinuutteinaGlobaali(kello);
        kello = minuutitKellonajaksi(Math.max(nykyinenKelloMin, omaAlku + kesto));
      } else {
        airtablePatch(TABLE_TYOTILAUKSET, tyoId, { 'Asentaja': [kohdeAsentajaId], 'kellonaika': kello });
        kello = minuutitKellonajaksi(kellonaikaMinuutteinaGlobaali(kello) + kesto);
      }
    });

    Logger.log('Työt järjestelty (' + email + ', ' + piste + ', ' + paivamaara + '): ' + JSON.stringify(tyoIdJarjestys));
    return jsonVastaus({ ok: true });

  } catch (err) {
    Logger.log('Työn järjestely epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleTyonSiirtoRuutuun(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata kapasiteettia (' + email + ')' });
    }

    const tyoId = String(body.tyoId || '');
    const asentajaId = String(body.asentajaId || '');
    const kellonaika = String(body.kellonaika || '');
    const piste = body.piste || '';

    if (!RECORD_ID_MUOTO.test(tyoId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen työn tunniste.' });
    }
    if (!RECORD_ID_MUOTO.test(asentajaId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen asentajan tunniste.' });
    }
    if (!/^\d{1,2}:\d{2}$/.test(kellonaika)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen kellonaika: ' + kellonaika });
    }

    const pisteet = haeSallitutPisteetLopullinen(email);
    if (pisteet === null || !pisteet.includes(piste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän pisteeseen (' + piste + ')' });
    }

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
    if (!tyoRecord) {
      return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });
    }

    // PÄIVITETTY 25.8.2026: "Työn alla" -tilassa olevaa työtä ei saa enää
    // siirtää — sama esto kuin kasitteleTyoJarjestely-funktiossa (ks. sen
    // kommentti). Aiemmin vain "Valmis" esti tämän.
    if (tyoRecord.fields['tila'] === 'Valmis' || tyoRecord.fields['tila'] === 'Työn alla') {
      return jsonVastaus({
        ok: false,
        error: 'Työ on tilassa "' + tyoRecord.fields['tila'] + '" eikä sitä voi siirtää. Vaihda tila ensin varauskeskuksesta.'
      });
    }

    const onLukittu = tyoRecord.fields['Lukittu aika'] === true;
    const nykyinenKello = tyoRecord.fields['kellonaika'] || '';
    if (onLukittu && kellonaika !== nykyinenKello) {
      return jsonVastaus({
        ok: false,
        error: 'Työllä on lukittu aika (' + nykyinenKello + ') — asiakkaalle luvattua aikaa ei voi siirtää. ' +
               'Poista lukitus varauskeskuksesta jos aika on tarkoitus muuttaa.'
      });
    }

    const kentat = { 'Asentaja': [asentajaId] };
    if (!onLukittu) kentat['kellonaika'] = kellonaika;

    const paivitetty = airtablePatch(TABLE_TYOTILAUKSET, tyoId, kentat);
    if (!paivitetty || !paivitetty.id) {
      return jsonVastaus({ ok: false, error: 'Siirto epäonnistui' });
    }

    lisaaMuokkausHistoriaan(tyoId, email, 'Siirsi työn (' + kellonaika + ')');
    Logger.log('Työ siirretty ruutuun (' + email + '): ' + tyoId + ' -> ' + asentajaId + ' @ ' + kellonaika);
    return jsonVastaus({ ok: true, id: tyoId, kellonaika: onLukittu ? nykyinenKello : kellonaika });

  } catch (err) {
    Logger.log('Työn siirto ruutuun epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleRuudunSiirto(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata kapasiteettia (' + email + ')' });
    }

    const asentajaId = body.asentajaId || '';
    const kohdePiste = body.kohdePiste || '';
    const paivamaara = body.paivamaara || '';
    const ruutuja = Number(body.ruutuja) || 1;

    if (!asentajaId || !kohdePiste || !paivamaara) {
      return jsonVastaus({ ok: false, error: 'Asentaja, kohdepiste tai päivämäärä puuttuu' });
    }

    const pisteet = haeSallitutPisteetLopullinen(email);
    if (pisteet === null || !pisteet.includes(kohdePiste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän pisteeseen (' + kohdePiste + ')' });
    }

    const pisteRecord = airtableGet(TABLE_PISTEET, `{Nimi}="${kaavaTeksti(kohdePiste)}"`);
    if (!pisteRecord) {
      return jsonVastaus({ ok: false, error: 'Pistettä ei löytynyt: ' + kohdePiste });
    }
    if (pisteRecord.fields['Piste-tyyppi'] !== 'Oma') {
      return jsonVastaus({ ok: false, error: 'Asentajaa ei voi siirtää tämäntyyppiselle pisteelle (' + kohdePiste + ')' });
    }

    const olemassaOleva = airtableGet(
      TABLE_ASENTAJAN_SIJOITUKSET,
      `AND(FIND("${asentajaId}", ARRAYJOIN({Asentaja})), FIND("${pisteRecord.id}", ARRAYJOIN({Piste})), IS_SAME({Päivämäärä}, "${paivamaara}", 'day'), NOT({Lukittu}))`
    );

    if (olemassaOleva) {
      const uusiMaara = (olemassaOleva.fields['Ruutuja'] || 0) + ruutuja;
      airtablePatch(TABLE_ASENTAJAN_SIJOITUKSET, olemassaOleva.id, { 'Ruutuja': uusiMaara });
    } else {
      airtablePost(TABLE_ASENTAJAN_SIJOITUKSET, {
        'Päivämäärä': paivamaara,
        'Asentaja': [asentajaId],
        'Piste': [pisteRecord.id],
        'Ruutuja': ruutuja,
        'Lukittu': false,
      });
    }

    Logger.log('Ruutu siirretty (' + email + '): asentaja ' + asentajaId + ' -> ' + kohdePiste + ' (' + paivamaara + ')');
    return jsonVastaus({ ok: true });

  } catch (err) {
    Logger.log('Ruudun siirto epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasittelePeruSiirto(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata kapasiteettia (' + email + ')' });
    }

    const sijoitusId = body.sijoitusId || '';
    if (!sijoitusId) {
      return jsonVastaus({ ok: false, error: 'Sijoituksen id puuttuu' });
    }

    const rivi = airtableGetById(TABLE_ASENTAJAN_SIJOITUKSET, sijoitusId);
    if (!rivi) {
      return jsonVastaus({ ok: false, error: 'Siirtoa ei löydy (ehkä jo peruttu)' });
    }
    if (rivi.fields['Lukittu'] === true) {
      return jsonVastaus({ ok: false, error: 'Siirto on jo lukittu (käytetty varaukseen) eikä sitä voi enää perua' });
    }

    airtableDelete(TABLE_ASENTAJAN_SIJOITUKSET, sijoitusId);
    Logger.log('Siirto peruttu (' + email + '): ' + sijoitusId);
    return jsonVastaus({ ok: true });

  } catch (err) {
    Logger.log('Siirron peruminen epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function haeSallitutPisteetPalvelimella(email) {
  try {
    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    const tiedostot = kansio.getFilesByName(DRIVE_KAYTTAJAT_FILE);
    if (!tiedostot.hasNext()) return ALL_PISTEET.slice();

    const tiedosto = tiedostot.next();
    const kayttajat = JSON.parse(tiedosto.getBlob().getDataAsString());
    if (!Array.isArray(kayttajat)) return ALL_PISTEET.slice();

    const oma = kayttajat.find(k => (k.email || '').toLowerCase() === email);
    if (!oma) return null;

    const pisteet = Array.isArray(oma.locations) ? oma.locations.slice() : [];
    if (!pisteet.includes('TEST')) pisteet.push('TEST');
    return pisteet;
  } catch (e) {
    Logger.log('Käyttöoikeuksien luku epäonnistui: ' + e.message);
    return null;
  }
}

function onkoAdmin(email) {
  const kayttajat = lueKayttajaLista();
  const oma = kayttajat.find(k => (k.email || '').toLowerCase() === email);
  return !!(oma && oma.admin === true);
}

function onkoRooli(email, rooli) {
  const kayttajat = lueKayttajaLista();
  const oma = kayttajat.find(k => (k.email || '').toLowerCase() === email);
  return !!(oma && Array.isArray(oma.roolit) && oma.roolit.includes(rooli));
}

function henkiloRiviAdminMuotoon(r) {
  const f = r.fields || {};
  const etu = f['Etunimi'] || '';
  const suku = f['Sukunimi'] || '';
  return {
    id: r.id,
    name: (etu + ' ' + suku).trim(),
    kutsumanimi: f['Kutsumanimi'] || '',
    email: f['Sähköposti'] || '',
    locations: Array.isArray(f['Sallitut pisteet']) ? f['Sallitut pisteet'].slice() : [],
    admin: f['Admin'] === true,
    roolit: Array.isArray(f['Roolit']) ? f['Roolit'].slice() : [], // record id:t
    nakyvyystaso: f['Näkyvyystaso'] || '',
    ryhma: f['Ryhmä'] || '',
    tila: f['Tila'] || '',
  };
}

function haeKayttajatAirtablesta() {
  const rivit = airtableListAll(TABLE_HENKILOT, 'TRUE()', null, null);
  return rivit.map(henkiloRiviAdminMuotoon);
}

function normalisoiNakyvyystaso(arvo) {
  const sallitut = ['Suppea', 'Keski', 'Laaja'];
  const teksti = String(arvo || '').trim();
  if (!teksti) return '';
  const osuma = sallitut.find(s => s.toLowerCase() === teksti.toLowerCase());
  return osuma || '';
}

function jaaNimiKentiksi(kokoNimi) {
  const teksti = String(kokoNimi || '').trim();
  if (!teksti) return { etunimi: '', sukunimi: '' };
  const i = teksti.lastIndexOf(' ');
  if (i === -1) return { etunimi: teksti, sukunimi: '' };
  return { etunimi: teksti.slice(0, i).trim(), sukunimi: teksti.slice(i + 1).trim() };
}

function haeHenkiloEmaililla(email) {
  if (!email) return null;
  return valimuistista('henkilo_' + email.toLowerCase(), function() {
    const rivi = airtableGet(TABLE_HENKILOT, `LOWER({Sähköposti})="${kaavaTeksti(email.toLowerCase())}"`);
    return rivi || null;
  }, false);
}

function haeSallitutPisteetAirtablesta(email) {
  try {
    const henkilo = haeHenkiloEmaililla(email);
    if (!henkilo) return null;
    if (henkilo.fields['Tila'] !== 'Aktiivinen') return null;

    const pisteet = Array.isArray(henkilo.fields['Sallitut pisteet'])
      ? henkilo.fields['Sallitut pisteet'].slice() : [];
    if (!pisteet.includes('TEST')) pisteet.push('TEST');
    return pisteet;
  } catch (e) {
    Logger.log('haeSallitutPisteetAirtablesta epäonnistui: ' + e.message);
    return null;
  }
}

function onkoAdminAirtablesta(email) {
  const henkilo = haeHenkiloEmaililla(email);
  return !!(henkilo && henkilo.fields['Admin'] === true);
}

function haeRoolitNimetById() {
  return valimuistista('v1_roolit', function() {
    const rivit = airtableListAll(TABLE_ROOLIT, 'TRUE()', null, null);
    const nimet = {};
    rivit.forEach(r => { nimet[r.id] = r.fields['Nimi'] || ''; });
    return nimet;
  }, true);
}

function onkoRooliAirtablesta(email, rooli) {
  const henkilo = haeHenkiloEmaililla(email);
  if (!henkilo) return false;
  const roolitLinkit = henkilo.fields['Roolit'];
  if (!Array.isArray(roolitLinkit) || roolitLinkit.length === 0) return false;
  const roolitNimetById = haeRoolitNimetById();
  return roolitLinkit.some(id => (roolitNimetById[id] || '').toLowerCase() === (rooli || '').toLowerCase());
}

function testaaHenkilotVertailu() {
  const vanhaLista = lueKayttajaLista();
  const erot = [];
  const tulokset = [];

  vanhaLista.forEach(vanha => {
    const email = (vanha.email || '').toLowerCase();
    if (!email) return;

    const vanhaPisteet = haeSallitutPisteetPalvelimella(email) || [];
    const uusiPisteet = haeSallitutPisteetAirtablesta(email) || [];
    const vanhaAdmin = onkoAdmin(email);
    const uusiAdmin = onkoAdminAirtablesta(email);
    const vanhaVarauskeskus = onkoRooli(email, 'varauskeskus');
    const uusiVarauskeskus = onkoRooliAirtablesta(email, 'varauskeskus');

    const pisteetTasmaa = JSON.stringify(vanhaPisteet.slice().sort()) === JSON.stringify(uusiPisteet.slice().sort());
    const kaikkiTasmaa = pisteetTasmaa && vanhaAdmin === uusiAdmin && vanhaVarauskeskus === uusiVarauskeskus;

    const rivi = {
      email: email,
      tasmaa: kaikkiTasmaa,
      vanha_pisteet: vanhaPisteet,
      uusi_pisteet: uusiPisteet,
      vanha_admin: vanhaAdmin,
      uusi_admin: uusiAdmin,
      vanha_varauskeskus: vanhaVarauskeskus,
      uusi_varauskeskus: uusiVarauskeskus,
    };
    tulokset.push(rivi);
    if (!kaikkiTasmaa) erot.push(rivi);
  });

  const yhteenveto = {
    yhteensa: tulokset.length,
    tasmaavia: tulokset.length - erot.length,
    eroja: erot.length,
    erot: erot,
    kaikki: tulokset,
  };

  Logger.log(JSON.stringify(yhteenveto, null, 2));
  return JSON.stringify(yhteenveto, null, 2);
}

function haeSallitutPisteetLopullinen(email) {
  const uusi = haeSallitutPisteetAirtablesta(email);
  if (uusi !== null) return uusi;
  return haeSallitutPisteetPalvelimella(email);
}

function onkoAdminLopullinen(email) {
  const henkilo = haeHenkiloEmaililla(email);
  if (henkilo) return onkoAdminAirtablesta(email);
  return onkoAdmin(email);
}

function onkoRooliLopullinen(email, rooli) {
  const henkilo = haeHenkiloEmaililla(email);
  if (henkilo) return onkoRooliAirtablesta(email, rooli);
  return onkoRooli(email, rooli);
}

function onkoOikeus(email, permission) {
  return onkoRooliLopullinen(email, permission);
}

function testaaLopullinenVertailu() {
  const vanhaLista = lueKayttajaLista();
  const erot = [];
  const tulokset = [];

  vanhaLista.forEach(vanha => {
    const email = (vanha.email || '').toLowerCase();
    if (!email) return;

    const vanhaPisteet = haeSallitutPisteetPalvelimella(email) || [];
    const uusiPisteet = haeSallitutPisteetLopullinen(email) || [];
    const vanhaAdmin = onkoAdmin(email);
    const uusiAdmin = onkoAdminLopullinen(email);
    const vanhaVarauskeskus = onkoRooli(email, 'varauskeskus');
    const uusiVarauskeskus = onkoOikeus(email, 'varauskeskus');

    const pisteetTasmaa = JSON.stringify(vanhaPisteet.slice().sort()) === JSON.stringify(uusiPisteet.slice().sort());
    const kaikkiTasmaa = pisteetTasmaa && vanhaAdmin === uusiAdmin && vanhaVarauskeskus === uusiVarauskeskus;

    const rivi = { email, tasmaa: kaikkiTasmaa, vanhaPisteet, uusiPisteet, vanhaAdmin, uusiAdmin, vanhaVarauskeskus, uusiVarauskeskus };
    tulokset.push(rivi);
    if (!kaikkiTasmaa) erot.push(rivi);
  });

  const yhteenveto = { yhteensa: tulokset.length, tasmaavia: tulokset.length - erot.length, eroja: erot.length, erot, kaikki: tulokset };
  Logger.log(JSON.stringify(yhteenveto, null, 2));
  return JSON.stringify(yhteenveto, null, 2);
}

function kasitteleVakuutustietojenPaivitys(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata vakuutustietoja (' + email + ')' });
    }

    const tyoId = String(body.tyoId || '');
    if (!RECORD_ID_MUOTO.test(tyoId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen työn tunniste.' });
    }

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
    if (!tyoRecord) {
      return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });
    }

    const pisteet = haeSallitutPisteetLopullinen(email);
    const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
    if (pisteet === null || !pisteet.includes(tyoPiste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
    }

    const kentat = {};
    if (body.laskutuslupatunnus !== undefined) {
      kentat['Laskutuslupatunnus'] = String(body.laskutuslupatunnus || '').trim();
    }
    if (body.vahinkotunnus !== undefined) {
      kentat['Vahinkotunnus'] = String(body.vahinkotunnus || '').trim();
    }
    if (body.vahinkopaiva !== undefined) {
      kentat['Vahinkopäivä'] = String(body.vahinkopaiva || '').trim();
    }
    if (body.omavastuu !== undefined) {
      kentat['Omavastuu'] = numeroTaiNull(body.omavastuu);
    }
    if (body.lasiturva !== undefined) {
      kentat['Lasiturva voimassa'] =
        (body.lasiturva === 'Kyllä' || body.lasiturva === 'Ei') ? body.lasiturva : 'Ei tarkistettu';
    }
    if (body.tarkistettu !== undefined) {
      kentat['Vakuutus tarkistettu'] = body.tarkistettu === true;
    }
    if (body.alvVahennyskelpoinen !== undefined) {
      kentat['ALV-vähennyskelpoinen'] = body.alvVahennyskelpoinen === true;
    }

    if (Object.keys(kentat).length === 0) {
      return jsonVastaus({ ok: false, error: 'Ei päivitettäviä kenttiä.' });
    }

    const kaikki = airtableListAll(TABLE_VAKUUTUSTAPAUKSET, 'TRUE()', null, null);
    const olemassa = kaikki.find(vt => (vt.fields['Työtilaus'] || []).includes(tyoId));

    if (olemassa) {
      const paivitetty = airtablePatch(TABLE_VAKUUTUSTAPAUKSET, olemassa.id, kentat);
      if (!paivitetty || !paivitetty.id) {
        return jsonVastaus({ ok: false, error: 'Vakuutustietojen päivitys epäonnistui.' });
      }
      lisaaMuokkausHistoriaan(tyoId, email, 'Päivitti vakuutustiedot');
      return jsonVastaus({ ok: true, id: olemassa.id, luotiinUusi: false });
    }

    kentat['Työtilaus'] = [tyoId];
    if (!kentat['Tila']) kentat['Tila'] = 'Ilmoitettu';
    const luotu = airtablePost(TABLE_VAKUUTUSTAPAUKSET, kentat);
    if (!luotu || !luotu.id) {
      return jsonVastaus({ ok: false, error: 'Vakuutustapauksen luonti epäonnistui.' });
    }
    lisaaMuokkausHistoriaan(tyoId, email, 'Lisäsi vakuutustiedot');
    return jsonVastaus({ ok: true, id: luotu.id, luotiinUusi: true });

  } catch (err) {
    Logger.log('Vakuutustietojen päivitys epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleYhdenKayttajanTallennus(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei admin-oikeutta tällä tilillä (' + email + ')' });
    }

    const user = body.user || {};
    const onUusi = !user.id;

    if (!String(user.name || '').trim() && !String(user.email || '').trim()) {
      return jsonVastaus({ ok: false, error: 'Anna vähintään nimi tai sähköposti.' });
    }

    const roolitIdt = suodataRecordIdt(user.roolit);

    const kentat = {
      'Kutsumanimi':       String(user.kutsumanimi || '').trim(),
      'Sähköposti':        String(user.email || '').trim(),
      'Admin':             user.admin === true,
      'Roolit':            roolitIdt,
      'Sallitut pisteet':  Array.isArray(user.locations) ? user.locations : [],
      'Ryhmä':             String(user.ryhma || '').trim(),
    };

    // KORJAUS 6.9.2026: Näkyvyystaso lisätään payloadiin VAIN jos sille on
    // valittu oikea arvo. Tyhjä merkkijono aiheutti Airtable-virheen
    // (INVALID_MULTIPLE_CHOICE_OPTIONS) joka esti KOKO henkilön luonnin.
    const nakyvyystasoArvo = normalisoiNakyvyystaso(user.nakyvyystaso);
    if (nakyvyystasoArvo) {
      kentat['Näkyvyystaso'] = nakyvyystasoArvo;
    }

    if (onUusi) {
      const jaettu = jaaNimiKentiksi(user.name);
      kentat['Etunimi'] = jaettu.etunimi;
      kentat['Sukunimi'] = jaettu.sukunimi;
      kentat['Tila'] = 'Aktiivinen';

      const luotu = airtablePost(TABLE_HENKILOT, kentat);
      if (!luotu || !luotu.id) {
        return jsonVastaus({ ok: false, error: 'Henkilön luonti epäonnistui.' });
      }
      Logger.log('Henkilö luotu (' + email + '): ' + luotu.id + ' / ' + kentat['Sähköposti']);
      return jsonVastaus({ ok: true, id: luotu.id });
    }

    if (!RECORD_ID_MUOTO.test(String(user.id))) {
      return jsonVastaus({ ok: false, error: 'Virheellinen henkilön tunniste.' });
    }

    const nykyinen = airtableGetById(TABLE_HENKILOT, user.id);
    if (!nykyinen) {
      return jsonVastaus({ ok: false, error: 'Henkilöä ei löydy: ' + user.id });
    }

    const nykyinenNimi = ((nykyinen.fields['Etunimi'] || '') + ' ' +
                          (nykyinen.fields['Sukunimi'] || '')).trim();
    if (String(user.name || '').trim() !== nykyinenNimi) {
      const jaettu = jaaNimiKentiksi(user.name);
      kentat['Etunimi'] = jaettu.etunimi;
      kentat['Sukunimi'] = jaettu.sukunimi;
    }

    const paivitetty = airtablePatch(TABLE_HENKILOT, user.id, kentat);
    if (!paivitetty || !paivitetty.id) {
      return jsonVastaus({ ok: false, error: 'Päivitys epäonnistui.' });
    }
    Logger.log('Henkilö päivitetty (' + email + '): ' + user.id);
    return jsonVastaus({ ok: true, id: paivitetty.id });

  } catch (err) {
    Logger.log('Henkilön tallennus epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleRyhmanPaivitys(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei admin-oikeutta tällä tilillä (' + email + ')' });
    }

    const henkiloId = String(body.henkiloId || '');
    if (!RECORD_ID_MUOTO.test(henkiloId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen henkilön tunniste.' });
    }

    const paivitetty = airtablePatch(TABLE_HENKILOT, henkiloId, {
      'Ryhmä': String(body.ryhma || '').trim()
    });
    if (!paivitetty || !paivitetty.id) {
      return jsonVastaus({ ok: false, error: 'Ryhmän päivitys epäonnistui.' });
    }
    return jsonVastaus({ ok: true, id: paivitetty.id });

  } catch (err) {
    Logger.log('Ryhmän päivitys epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleKayttajalistanTallennus(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';

    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei admin-oikeutta tällä tilillä (' + email + ')' });
    }

    const users = Array.isArray(body.users) ? body.users : null;
    if (!users) {
      return jsonVastaus({ ok: false, error: 'Käyttäjälista puuttuu tai on virheellinen' });
    }

    const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
    const tiedostot = kansio.getFilesByName(DRIVE_KAYTTAJAT_FILE);
    const sisalto = JSON.stringify(users, null, 2);

    if (tiedostot.hasNext()) {
      tiedostot.next().setContent(sisalto);
    } else {
      kansio.createFile(DRIVE_KAYTTAJAT_FILE, sisalto, MimeType.PLAIN_TEXT);
    }

    Logger.log('Käyttäjälista tallennettu (' + email + '): ' + users.length + ' käyttäjää');
    return jsonVastaus({ ok: true, tallennettu: users.length });

  } catch (err) {
    Logger.log('Käyttäjälistan tallennus epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function lisaaMuokkausHistoriaan(recordId, email, kuvaus) {
  try {
    const record = airtableGetById(TABLE_TYOTILAUKSET, recordId);
    const vanha = (record && record.fields['Muokkaushistoria']) || '';
    const aikaleima = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Helsinki', 'dd.MM.yyyy HH:mm');
    const uusiRivi = `${aikaleima} — ${email}: ${kuvaus}`;
    const uusi = vanha ? (vanha + '\n' + uusiRivi) : uusiRivi;
    airtablePatch(TABLE_TYOTILAUKSET, recordId, { 'Muokkaushistoria': uusi });
  } catch (e) {
    Logger.log('Muokkaushistorian tallennus epäonnistui: ' + e.message);
  }
}

const TARKASTUSTYYPIT_ALKU = {
  vikakoodit: 'Vikakoodit',
  suojaimet:  'Pyyhkijät/pissapoika/sadetunnistin',
  suojaus:    'Suojaus'
};

const TARKASTUSTYYPIT_KAANNOS = {
  'Vikakoodit': 'vikakoodit',
  'Pyyhkijät/pissapoika/sadetunnistin': 'suojaimet',
  'Suojaus': 'suojaus'
};

function haeTehdytTarkastukset(tyoId) {
  try {
    const formula = `AND(FIND("${tyoId}", ARRAYJOIN({Työtilaus})), {Vaihe}="Alku")`;
    const rivit = airtableList(TABLE_TARKASTUKSET, formula);
    return rivit.map(r => TARKASTUSTYYPIT_KAANNOS[r.fields['Tarkastustyyppi']] || '').filter(Boolean);
  } catch (e) {
    Logger.log('Tehtyjen tarkastusten haku epäonnistui (' + tyoId + '): ' + e.message);
    return [];
  }
}

function tallennaAlkutarkastus(tyoId, email, tarkastusJson) {
  try {
    const tarkastukset = JSON.parse(tarkastusJson);
    const avaimet = Object.keys(tarkastukset);
    if (avaimet.length === 0) return;

    let virheita = 0;
    avaimet.forEach(avain => {
      const tarkastustyyppi = TARKASTUSTYYPIT_ALKU[avain] || avain;
      const tulos = airtablePost(TABLE_TARKASTUKSET, {
        'Työtilaus': [tyoId],
        'Tarkastustyyppi': tarkastustyyppi,
        'Vaihe': 'Alku',
        'Aikaleima': tarkastukset[avain],
        'Asentaja': email
      });
      if (!tulos || !tulos.id) {
        virheita++;
        Logger.log('Tarkastuksen tallennus epäonnistui [' + avain + ']: ' + JSON.stringify(tulos));
      }
    });

    if (virheita > 0) {
      merkitseTarkastusVirhe(tyoId, email, virheita, avaimet.length);
    }

  } catch (e) {
    Logger.log('Alkutarkastuksen käsittely epäonnistui kokonaan: ' + e.message);
    merkitseTarkastusVirhe(tyoId, email, -1, -1);
  }
}

function merkitseTarkastusVirhe(tyoId, email, virheita, yhteensa) {
  try {
    lisaaMuokkausHistoriaan(tyoId, email, '⚠️ VIRHE: Tarkastusdataa ei saatu tallennettua' +
      (virheita > 0 ? ' (' + virheita + '/' + yhteensa + ' epäonnistui)' : ''));

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
    const vanhaTeksti = (tyoRecord && tyoRecord.fields['Lisätiedot']) || '';
    const aikaleima = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Helsinki', 'dd.MM.yyyy HH:mm');
    const huomio = '⚠️ TEKNINEN HUOMIO (' + aikaleima + '): Alkutarkastuksen tallennus epäonnistui. ' +
      'Laskun tarkistus on pakotettu päälle tälle työlle.';
    const uusiTeksti = vanhaTeksti ? (vanhaTeksti + '\n\n' + huomio) : huomio;

    airtablePatch(TABLE_TYOTILAUKSET, tyoId, {
      'Lisätiedot': uusiTeksti,
      'Laskun tarkistus': true
    });
  } catch (e) {
    Logger.log('Tarkastusvirheen merkintä epäonnistui (ei kriittistä): ' + e.message);
  }
}

function kasitteleVarauksenPaivitys(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';

    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    if (!onkoOikeus(email, 'varauskeskus') && !onkoAdminLopullinen(email)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta muokata varauksia (' + email + ')' });
    }

    const id = body.id || '';
    if (!id) {
      return jsonVastaus({ ok: false, error: 'Varauksen id puuttuu' });
    }

    const nykyinenRecord = airtableGetById(TABLE_TYOTILAUKSET, id);
    if (!nykyinenRecord) {
      return jsonVastaus({ ok: false, error: 'Varausta ei löydy' });
    }
    const nykyinenTila = nykyinenRecord.fields['tila'] || '';
    const LUKITUT_TILAT = ['Valmis'];
    const onLukittu = LUKITUT_TILAT.includes(nykyinenTila);

    if (onLukittu && body.fields) {
      const yrittiMuutaMuutakin = Object.keys(body.fields).some(k => k !== 'tila');
      if (yrittiMuutaMuutakin) {
        return jsonVastaus({
          ok: false,
          error: 'Varaus on tilassa "' + nykyinenTila + '" eikä sitä voi enää muokata. ' +
                 'Vaihda tila ensin takaisin (esim. "Työn alla") jos korjaus on tarpeen.'
        });
      }
    }

    const sallitutKentat = [
      'päivämäärä', 'kellonaika', 'tyyppi', 'tila', 'Lisätiedot', 'Laskun tarkistus',
      'Hinta', 'Lisäpalvelut', 'Tarvikkeet',
      'Leasing-yhtiö', 'Leasing-sopimusnumero', 'Leasing-lasiturva',
      'Kuljettajan nimi', 'Kuljettajan puhelin', 'Yhteyshenkilön sähköposti',
      'Työmääräysnumero', 'Autoliikkeen yhteyshenkilö',
      'Lasin hinta', 'Työn hinta', 'Tarvikkeiden hinta', 'Kalibroinnin hinta',
      'Varastopaikka',
    ];

    let tyyppiKestotById = null;
    function haeTyyppiKestotTarvittaessa() {
      if (!tyyppiKestotById) tyyppiKestotById = haeTyotyyppiKestot();
      return tyyppiKestotById;
    }

    const paivitykset = {};
    sallitutKentat.forEach(k => {
      if (!body.fields || !Object.prototype.hasOwnProperty.call(body.fields, k)) return;

      if (k === 'tyyppi') {
        const kestot = haeTyyppiKestotTarvittaessa();
        const tyyppiId = haeTyotyyppiId(body.fields[k], kestot);
        paivitykset[k] = tyyppiId ? [tyyppiId] : [];
      } else if (k === 'Lisäpalvelut') {
        const kestot = haeTyyppiKestotTarvittaessa();
        const nimet = String(body.fields[k] || '').split(',').map(s => s.trim()).filter(Boolean);
        const idt = nimet.map(n => haeTyotyyppiId(n, kestot)).filter(Boolean);
        paivitykset[k] = idt;
      } else {
        paivitykset[k] = body.fields[k];
      }
    });

    if (Object.keys(paivitykset).length === 0) {
      return jsonVastaus({ ok: false, error: 'Ei päivitettäviä kenttiä' });
    }

    const paivitetty = airtablePatch(TABLE_TYOTILAUKSET, id, paivitykset);
    if (paivitetty && paivitetty.id) {
      Logger.log('Varaus päivitetty (' + email + '): ' + id + ' -> ' + JSON.stringify(paivitykset));
      lisaaMuokkausHistoriaan(id, email, 'Muokkasi varausta (' + Object.keys(paivitykset).join(', ') + ')');
      return jsonVastaus({ ok: true, id: paivitetty.id });
    } else {
      Logger.log('Varauksen päivitys epäonnistui Airtable-tasolla (' + id + '): ' + JSON.stringify(paivitetty));
      return jsonVastaus({ ok: false, error: 'Päivitys epäonnistui' });
    }

  } catch (err) {
    Logger.log('Varauksen päivitys epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasittelePoikkeamanIlmoitus(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const id = body.id || '';
    const kuvaus = (body.kuvaus || '').trim();

    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }

    const pisteet = haeSallitutPisteetLopullinen(email);
    if (pisteet === null) {
      return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + email + ')' });
    }

    if (!id) {
      return jsonVastaus({ ok: false, error: 'Työn id puuttuu' });
    }
    if (!kuvaus) {
      return jsonVastaus({ ok: false, error: 'Kuvaus poikkeamasta puuttuu' });
    }

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, id);
    if (!tyoRecord) {
      return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });
    }
    const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
    if (!pisteet.includes(tyoPiste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
    }

    const aikaleima = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Helsinki', 'dd.MM.yyyy HH:mm');
    const vanhaTeksti = tyoRecord.fields['Lisätiedot'] || '';
    const uusiTeksti = (vanhaTeksti ? vanhaTeksti + '\n\n' : '') + '⚠️ POIKKEAMA (' + aikaleima + '):\n' + kuvaus;

    const paivitetty = airtablePatch(TABLE_TYOTILAUKSET, id, {
      'tila': 'Poikkeama',
      'Lisätiedot': uusiTeksti
    });

    if (paivitetty && paivitetty.id) {
      Logger.log('Poikkeama ilmoitettu (' + email + '): ' + id);
      lisaaMuokkausHistoriaan(id, email, 'Ilmoitti poikkeaman');
      return jsonVastaus({ ok: true, id: paivitetty.id, tila: 'Poikkeama' });
    } else {
      return jsonVastaus({ ok: false, error: 'Päivitys epäonnistui' });
    }

  } catch (err) {
    Logger.log('Poikkeaman ilmoitus epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

const _VN = 'ACDEFGHJKLMNPQRTUVWXY34679';

function vnEncode(n) {
  const b = _VN.length;
  let r = '';
  for (let i = 0; i < 5; i++) { r = _VN[n % b] + r; n = Math.floor(n / b); }
  return r;
}
function vnToCode(n) { return vnEncode(n ^ 0x5A3F9); }

function laskeVarausnumero(nro, tyyppi) {
  const vuosiNyt = new Date().getFullYear();
  const kirjain = tyyppi || 'V';
  return {
    jarjestysnumero: nro,
    varausnumero: `STM-${vuosiNyt}-${kirjain}${String(nro).padStart(5, '0')}`,
    asiakaskoodi: `STM-${vuosiNyt}-${kirjain}${vnToCode(nro)}`,
  };
}

function haeSeuraavaAsiakasnumero() {
  const now = new Date();
  const vvkk = Utilities.formatDate(now, 'Europe/Helsinki', 'yyMM');

  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ASIAKKAAT}` +
    `?filterByFormula=${encodeURIComponent('NOT({Asiakasnumero}="")')}` +
    `&sort[0][field]=Asiakasnumero&sort[0][direction]=desc&maxRecords=1`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText());

  let seuraavaJuoksevaNro = 1;
  if (data.records && data.records.length > 0) {
    const suurin = String(data.records[0].fields['Asiakasnumero'] || '');
    const juoksevaOsa = suurin.slice(-4);
    const juoksevaNro = parseInt(juoksevaOsa, 10);
    if (!isNaN(juoksevaNro)) {
      seuraavaJuoksevaNro = juoksevaNro + 1;
    }
  }

  const juoksevaPadded = String(seuraavaJuoksevaNro).padStart(4, '0');
  return vvkk + juoksevaPadded;
}

const PISTE_KALENTERIT = {
  'Hatanpää': 'skaneog934c1cesglhhs214q6c@group.calendar.google.com',
  'Kuopio':   '1cce97d7068766a94eccabdb2dd896e525fdb02554685ddf784e8f91a184f3d1@group.calendar.google.com',
  'Lahti':    '9a677c9c3b55f56e2ddbd2d058c26f7ce217a9f034d838af47cdea79629eb302@group.calendar.google.com',
  'Lempäälä': 'l3uh8hvqkpu3i0ogh2smgo3f2g@group.calendar.google.com',
  'Lielahti': '87372a206cdaddb920f64f06bc987295ae0b290d00b009b08f6668fd9ac0bb80@group.calendar.google.com',
  'Pirkkala': 'a1e6474cc31518d3d2b8cb04f1194cb267648204c359eb7f9757f4a643f4b8b4@group.calendar.google.com',
  'Vantaa':   '1b291cac1df805b5ee36b89b932ffa187e1631f6fa8d5c3613a01a2b499c375e@group.calendar.google.com',
  'Ylöjärvi': 'ajanvaraus.tuulilasit@gmail.com',
  'TEST':     '7d4afd2a7c67181d4963f25ed5b090f2d60786fe4fafbc266be482f3b22ca623@group.calendar.google.com',
};

function luoKalenteritapahtuma(tiedot) {
  try {
    const kalenteriId = PISTE_KALENTERIT[tiedot.piste];
    if (!kalenteriId) {
      return { ok: false, error: 'Tuntematon piste: ' + tiedot.piste };
    }

    const kalenteri = CalendarApp.getCalendarById(kalenteriId);
    if (!kalenteri) {
      return { ok: false, error: 'Kalenteria ei löytynyt tai ei oikeutta: ' + tiedot.piste };
    }

    const [vuosi, kk, pv] = tiedot.paivamaara.split('-').map(Number);
    const [tunti, min] = tiedot.kellonaika.split(':').map(Number);
    const alku = new Date(vuosi, kk - 1, pv, tunti, min);
    const kesto = tiedot.kestoMinuuttia || 60;
    const loppu = new Date(alku.getTime() + kesto * 60 * 1000);

    const tapahtuma = kalenteri.createEvent(
      tiedot.otsikko || 'Varaus',
      alku,
      loppu,
      { description: tiedot.kuvaus || '' }
    );

    return {
      ok: true,
      tapahtumaId: tapahtuma.getId(),
      linkki: 'Tapahtuma luotu: ' + tapahtuma.getTitle() + ' (' + alku.toLocaleString() + ')',
    };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const VIIKONPAIVAT = ['Sunnuntai','Maanantai','Tiistai','Keskiviikko','Torstai','Perjantai','Lauantai'];

function onkoPisteAuki(piste, paivamaara, kellonaika) {
  try {
    if (!piste || !paivamaara || !kellonaika) return true;

    const tiedot = haeAukiolo(piste, paivamaara);
    if (!tiedot) return true;
    if (!tiedot.onkoAuki) return false;
    if (!tiedot.aukiKlo || !tiedot.kiinniKlo) return true;

    return kellonaika >= tiedot.aukiKlo && kellonaika < tiedot.kiinniKlo;

  } catch (e) {
    Logger.log('Aukioloajan tarkistus epäonnistui, sallitaan varaus: ' + e.message);
    return true;
  }
}

function lataaKuvaDriveen(kansioId, tiedostonimi, base64Data, properties) {
  const boundary = '-------stm314159265358979';
  const metadata = { name: tiedostonimi, parents: [kansioId], properties: properties };

  const delimiter = '\r\n--' + boundary + '\r\n';
  const closeDelim = '\r\n--' + boundary + '--';

  const multipartBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: image/jpeg\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    base64Data +
    closeDelim;

  const resp = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    contentType: 'multipart/related; boundary="' + boundary + '"',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: multipartBody,
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText());
}

function haeToimittajat() {
  const rivit = airtableListAll(TABLE_TOIMITTAJAT, 'TRUE()', 'Käyttömäärä', 'desc');
  return rivit.map(r => r.fields['Nimi']).filter(Boolean);
}

function kasvataToimittajanKayttoa(nimi) {
  if (!nimi) return;
  const olemassaOleva = airtableGet(TABLE_TOIMITTAJAT, `{Nimi}="${kaavaTeksti(nimi)}"`);
  if (olemassaOleva) {
    airtablePatch(TABLE_TOIMITTAJAT, olemassaOleva.id, {
      'Käyttömäärä': (olemassaOleva.fields['Käyttömäärä'] || 0) + 1
    });
  } else {
    airtablePost(TABLE_TOIMITTAJAT, { 'Nimi': nimi, 'Käyttömäärä': 1 });
  }
}

function haeOmavastuut() {
  const rivit = airtableListAll(TABLE_OMAVASTUUT, 'TRUE()', 'Käyttömäärä', 'desc');
  return rivit.map(r => r.fields['Summa']).filter(v => v !== undefined && v !== null);
}

function kasvataOmavastuunKayttoa(summa) {
  if (summa === undefined || summa === null) return;
  const luku = Number(summa);
  if (!isFinite(luku)) return;
  summa = luku;
  const olemassaOleva = airtableGet(TABLE_OMAVASTUUT, `{Summa}=${summa}`);
  if (olemassaOleva) {
    airtablePatch(TABLE_OMAVASTUUT, olemassaOleva.id, {
      'Käyttömäärä': (olemassaOleva.fields['Käyttömäärä'] || 0) + 1
    });
  } else {
    airtablePost(TABLE_OMAVASTUUT, { 'Summa': summa, 'Käyttömäärä': 1 });
  }
}

function haeVakuutusJarjestys() {
  const rivit = airtableListAll(TABLE_VAKUUTUSJARJESTYS, 'TRUE()', 'Järjestys', 'asc');
  return rivit.map(r => r.fields['Nimi']).filter(Boolean);
}

function paivitaVakuutusJarjestys(valittuNimi) {
  if (!valittuNimi) return;
  const kaikki = airtableListAll(TABLE_VAKUUTUSJARJESTYS, 'TRUE()', 'Järjestys', 'asc');
  const ilmanValittua = kaikki.filter(r => r.fields['Nimi'] !== valittuNimi);
  const uusiJarjestys = [valittuNimi].concat(ilmanValittua.map(r => r.fields['Nimi'])).slice(0, 6);

  uusiJarjestys.forEach((nimi, index) => {
    const olemassaOleva = kaikki.find(r => r.fields['Nimi'] === nimi);
    if (olemassaOleva) {
      airtablePatch(TABLE_VAKUUTUSJARJESTYS, olemassaOleva.id, { 'Järjestys': index + 1 });
    } else {
      airtablePost(TABLE_VAKUUTUSJARJESTYS, { 'Nimi': nimi, 'Järjestys': index + 1 });
    }
  });
}

function kasitteleTarranTallennus(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const istuntoId = data.istunto || '';
    const email = haeKirjautuneenSahkoposti(istuntoId);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut.' });
    }

    const tiedostonimi = data.tiedostonimi || 'tarra.pdf';
    const pdfBase64 = data.pdfBase64 || '';
    if (!pdfBase64) {
      return jsonVastaus({ ok: false, error: 'PDF-data puuttuu.' });
    }

    const kansio = DriveApp.getFolderById(DRIVE_TARRAT_FOLDER);
    const blob = Utilities.newBlob(
      Utilities.base64Decode(pdfBase64), 'application/pdf', tiedostonimi
    );
    const tiedosto = kansio.createFile(blob);

    return jsonVastaus({ ok: true, fileId: tiedosto.getId() });
  } catch (e) {
    Logger.log('Tarran tallennus epäonnistui: ' + e.message);
    return jsonVastaus({ ok: false, error: e.message });
  }
}

function haeTaiLuoKuvakansio(nimi) {
  const paakansio = DriveApp.getFolderById(DRIVE_KUVAT_FOLDER);
  const olemassa = paakansio.getFoldersByName(nimi);
  if (olemassa.hasNext()) return olemassa.next().getId();
  return paakansio.createFolder(nimi).getId();
}

function tyhjennaKuvakansio(kansioId) {
  const kansio = DriveApp.getFolderById(kansioId);
  const tiedostot = kansio.getFiles();
  while (tiedostot.hasNext()) {
    tiedostot.next().setTrashed(true);
  }
}

function laskeLisakuvienMaara(kansioId) {
  const kansio = DriveApp.getFolderById(kansioId);
  const tiedostot = kansio.getFiles();
  let maara = 0;
  while (tiedostot.hasNext()) {
    const nimi = tiedostot.next().getName();
    if (nimi.indexOf('-Lisakuva') !== -1 || nimi.indexOf('-Lisäkuva') !== -1) {
      maara++;
    }
  }
  return maara;
}

function kasitteleKuvienTallennus(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const email = haeKirjautuneenSahkoposti(token);
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }

    const tyoId = body.id || '';
    const kuvat = Array.isArray(body.kuvat) ? body.kuvat : [];
    if (!tyoId) return jsonVastaus({ ok: false, error: 'Työn id puuttuu' });
    if (kuvat.length === 0) return jsonVastaus({ ok: false, error: 'Ei kuvia lähetettäväksi' });

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
    if (!tyoRecord) return jsonVastaus({ ok: false, error: 'Työtä ei löydy' });

    const pisteet = haeSallitutPisteetLopullinen(email);
    const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
    if (pisteet === null || !pisteet.includes(tyoPiste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
    }

    const rekisteri = (body.rekisteri || 'TUNTEMATON').replace(/[^A-Z0-9]/gi, '');
    const asiakaskoodi = body.asiakaskoodi || '';
    const now = new Date();
    const pvm = Utilities.formatDate(now, 'Europe/Helsinki', 'yyyy-MM-dd');
    const kansioNimi = `${rekisteri}-${pvm}-${asiakaskoodi}`;
    const kansioId = haeTaiLuoKuvakansio(kansioNimi);

    const onLisakuva = body.onLisakuva === true;
    let lisakuvaLaskuri = 0;
    if (onLisakuva) {
      lisakuvaLaskuri = laskeLisakuvienMaara(kansioId);
    } else {
      tyhjennaKuvakansio(kansioId);
    }

    const properties = {
      piste: tyoPiste,
      asiakaskoodi: asiakaskoodi,
      kuvanottaja: email,
      sijainti: body.sijainti ? `${body.sijainti.lat},${body.sijainti.lng}` : ''
    };

    let onnistuneet = 0;
    for (const kuva of kuvat) {
      const aikaleima = Utilities.formatDate(now, 'Europe/Helsinki', 'yyyy-MM-dd-HH-mm');
      let tiedostonimi;
      if (onLisakuva) {
        lisakuvaLaskuri++;
        tiedostonimi = `${rekisteri}-Lisakuva${lisakuvaLaskuri}-${aikaleima}.jpg`;
      } else {
        tiedostonimi = `${rekisteri}-${kuva.id}-${aikaleima}.jpg`;
      }
      const base64 = (kuva.dataUrl || '').split(',')[1] || '';
      if (!base64) continue;
      const tulos = lataaKuvaDriveen(kansioId, tiedostonimi, base64, properties);
      if (tulos && tulos.id) {
        onnistuneet++;
        Logger.log('Kuva tallennettu: ' + tulos.id + ' — metatiedot: ' + JSON.stringify(properties));
      }
      else Logger.log('Kuvan lataus epäonnistui: ' + JSON.stringify(tulos));
    }

    if (onnistuneet === 0) {
      return jsonVastaus({ ok: false, error: 'Yhtään kuvaa ei saatu tallennettua' });
    }

    const kansioLinkki = `https://drive.google.com/drive/folders/${kansioId}`;
    if (!onLisakuva) {
      airtablePatch(TABLE_TYOTILAUKSET, tyoId, { 'Kuvat': kansioLinkki });
    }
    lisaaMuokkausHistoriaan(tyoId, email, onLisakuva
      ? `Lisäsi ${onnistuneet} lisäkuvaa`
      : `Tallensi ${onnistuneet} kuvaa`);

    return jsonVastaus({ ok: true, kansioLinkki: kansioLinkki, tallennettu: onnistuneet, yhteensa: kuvat.length });

  } catch (err) {
    Logger.log('Kuvien tallennus epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function doPostSisainen(e) {
  try {
    tarkistaVaadititutAsetukset();
    if (!tarkistaPyyntoRaja()) {
      return jsonVastaus({ ok: false, error: 'Liikaa pyyntöjä lyhyessä ajassa. Yritä hetken kuluttua uudelleen.' });
    }
    const action = (e.parameter && e.parameter.action) || '';

    if (action === 'luoIstunto') {
      const body = JSON.parse(e.postData.contents);
      const googleToken = body.token || '';
      const email = haeKirjautuneenSahkoposti(googleToken);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Google-kirjautuminen epäonnistui tai vanhentunut.' });
      }
      const istuntoId = luoIstunto(email);
      return jsonVastaus({ ok: true, istuntoId: istuntoId, email: email });
    }

    if (action === 'tallennaKayttajalista') {
      return kasitteleKayttajalistanTallennus(e);
    }

    if (action === 'lisaaLaskurivi') {
      return kasitteleLaskurivinLisays(e);
    }

    if (action === 'poistaLaskurivi') {
      return kasitteleLaskurivinPoisto(e);
    }

    if (action === 'tallennaYksiKayttaja') {
      return kasitteleYhdenKayttajanTallennus(e);
    }

    if (action === 'paivitaRyhma') {
      return kasitteleRyhmanPaivitys(e);
    }

    if (action === 'paivitaVakuutustiedot') {
      return kasitteleVakuutustietojenPaivitys(e);
    }

    if (action === 'paivitaVaraus') {
      return kasitteleVarauksenPaivitys(e);
    }

    if (action === 'ilmoitaPoikkeama') {
      return kasittelePoikkeamanIlmoitus(e);
    }

    if (action === 'paivitaMuisti') {
      const body = JSON.parse(e.postData.contents);
      const tunnus = body.istunto || '';
      const email = haeKirjautuneenSahkoposti(tunnus);
      if (!email) {
        return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut.' });
      }
      if (body.toimittaja) kasvataToimittajanKayttoa(body.toimittaja);
      if (body.omavastuu !== undefined && body.omavastuu !== null && body.omavastuu !== '') {
        kasvataOmavastuunKayttoa(Number(body.omavastuu));
      }
      if (body.vakuutus) paivitaVakuutusJarjestys(body.vakuutus);
      return jsonVastaus({ ok: true });
    }

    if (action === 'tallennaTarraPdf') {
      return kasitteleTarranTallennus(e);
    }

    if (action === 'tallennaKuvat') {
      return kasitteleKuvienTallennus(e);
    }

    if (action === 'tallennaPisteJarjestys') {
      return kasittelePisteJarjestyksenTallennus(e);
    }

    if (action === 'jarjesteleTyot') {
      return kasitteleTyoJarjestely(e);
    }

    if (action === 'siirraTyoRuutuun') {
      return kasitteleTyonSiirtoRuutuun(e);
    }

    if (action === 'siirraRuutu') {
      return kasitteleRuudunSiirto(e);
    }

    if (action === 'peruSiirto') {
      return kasittelePeruSiirto(e);
    }

    const data = JSON.parse(e.postData.contents);
    Logger.log('LOMAKEDATA: ' + JSON.stringify(data));

    const kirjautunutEmail = haeKirjautuneenSahkoposti(data.token);
    if (!kirjautunutEmail) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }
    const sallitutPisteet = haeSallitutPisteetLopullinen(kirjautunutEmail);
    if (sallitutPisteet === null) {
      return jsonVastaus({ ok: false, error: 'Ei käyttöoikeutta tällä tilillä (' + kirjautunutEmail + ')' });
    }
    if (!sallitutPisteet.includes(data.piste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + data.piste + ')' });
    }
    if (!onkoPisteAuki(data.piste, data.paivamaara, data.kellonaika)) {
      return jsonVastaus({ ok: false, error: 'Piste on kiinni valittuna ajankohtana. Tarkista aukioloajat.' });
    }

    const tulos = suoritaVarauksenTallennus(data, kirjautunutEmail);
    return jsonVastaus(tulos);
  } catch (err) {
    Logger.log('doPost kaatui: ' + err.message + ' | stack: ' + (err.stack || '-'));
    return jsonVastaus({ ok: false, error: 'Palvelinvirhe: ' + err.message });
  }
}

// UUSI 24.8.2026: kokoaa autoliikkeen myyjän nimen ja puhelimen yhdeksi
// tekstiksi Airtablen 'Autoliikkeen yhteyshenkilö' -kenttää varten (yksi
// tekstikenttä, ei erillisiä nimi-/puhelinkenttiä). Puhelin liitetään perään
// vain jos se on annettu, jotta kenttään ei jää roikkumaan tyhjää sulkuparia.
// Palauttaa tyhjän merkkijonon jos myyjää ei ole annettu — silloin kenttä
// tyhjennetään, mikä on oikein esim. jos varauksen tyyppi vaihdetaan
// autoliikkeestä joksikin muuksi.
function koostaMyyja(data) {
  const nimi = String(data.myyjaNimi || '').trim();
  const puhelin = String(data.myyjaPuhelin || '').trim();
  if (!nimi && !puhelin) return '';
  if (!puhelin) return nimi;
  if (!nimi) return puhelin;
  return nimi + ' (' + puhelin + ')';
}

function suoritaVarauksenTallennus(data, kirjautunutEmail) {
  try {
    Logger.log('SAHKOPOSTI: ' + data.sahkoposti);
    Logger.log('OMISTAJA: ' + data.omistajaTyyppi);

    // DUPLIKAATTIESTO 26.8.2026: käyttäjän kokemus 26.8. — vahvistusnappi
    // näytti epäonnistuvan (verkkovastaus ei ehtinyt selaimeen asti, esim.
    // Apps Scriptin googleusercontent.com-välityskerroksen ohimenevä 404),
    // vaikka palvelin oli jo tallentanut varauksen onnistuneesti. Käyttäjä
    // yritti uudelleen useita kertoja peräkkäin (myös sivun uudelleenlataus
    // ohittaa selaimen napinlukituksen), ja neljä identtistä työtilausta
    // syntyi samalle autolle/ajalle muutaman minuutin sisällä.
    //
    // Tämä tarkistus estää sen: jos täsmälleen sama rekisterinumero +
    // päivämäärä + kellonaika + piste on jo tallennettu viimeisen 10
    // minuutin sisällä, palautetaan se olemassa oleva varaus uuden luonnin
    // sijaan. 10 minuuttia on riittävän lyhyt aika, ettei se estä oikeaa
    // uutta varausta (esim. sama auto tulisi huomenna uudelleen), mutta
    // riittävän pitkä kattamaan käyttäjän toistuvat yrityskerrat.
    const dupRekisteri = String(data.rekisteri || '').trim();
    if (dupRekisteri && data.piste && data.paivamaara && data.kellonaika) {
      try {
        const kymmenenMinuuttiaSitten = new Date(Date.now() - 10 * 60 * 1000);
        const dupFormula = `AND(` +
          `{rekisterinumero}="${kaavaTeksti(dupRekisteri)}", ` +
          `{päivämäärä}="${kaavaTeksti(data.paivamaara)}", ` +
          `{kellonaika}="${kaavaTeksti(data.kellonaika)}", ` +
          `{asennuspiste/location}="${kaavaTeksti(data.piste)}", ` +
          `IS_AFTER(CREATED_TIME(), DATETIME_PARSE("${Utilities.formatDate(kymmenenMinuuttiaSitten, 'Europe/Helsinki', "yyyy-MM-dd'T'HH:mm:ss")}"))` +
          `)`;
        const olemassaOlevaVaraus = airtableGet(TABLE_TYOTILAUKSET, dupFormula);
        if (olemassaOlevaVaraus) {
          Logger.log('DUPLIKAATTI ESTETTY: rekisteri=' + dupRekisteri + ', palautetaan olemassa oleva ' +
            (olemassaOlevaVaraus.fields['varausnumero'] || olemassaOlevaVaraus.id));
          return {
            ok: true,
            id: olemassaOlevaVaraus.id,
            varausnumero: olemassaOlevaVaraus.fields['varausnumero'] || '',
            asiakaskoodi: olemassaOlevaVaraus.fields['asiakaskoodi'] || '',
            smsDebug: 'Duplikaatti estetty — palautettiin olemassa oleva varaus, ei lähetetty uutta SMS:ää.',
            maksajaVaroitus: '',
            duplikaattiEstetty: true,
          };
        }
      } catch (dupErr) {
        // Duplikaattitarkistuksen epäonnistuminen ei saa estää varauksen
        // tekoa — parempi mahdollinen harvinainen duplikaatti kuin ettei
        // varaus tallennu ollenkaan.
        Logger.log('Duplikaattitarkistus epäonnistui (ei kriittistä, jatketaan): ' + dupErr.message);
      }
    }

    // TURVALLISUUS 24.8.2026: asiakasId tulee selaimelta. Sitä ei ole aiemmin
    // tarkistettu lainkaan, ja nyt se menee myös Airtablen URL-polkuun
    // (airtableGetById). Hyväksytään vain aito record id -muoto; kaikki muu
    // hylätään hiljaisesti, jolloin asiakas haetaan normaalia reittiä.
    let asiakasId = null;
    const pyydettyAsiakasId = String(data.asiakasId || '').trim();
    if (pyydettyAsiakasId) {
      if (RECORD_ID_MUOTO.test(pyydettyAsiakasId)) {
        asiakasId = pyydettyAsiakasId;
      } else {
        Logger.log('Virheellinen asiakasId hylätty: ' + pyydettyAsiakasId);
      }
    }
    const omistajaTyyppi = data.omistajaTyyppi || 'yksityinen';

    // KORJAUS 24.8.2026: lomakkeen Asiakkaan haku etsii HENKILÖÄ (puhelin,
    // sähköposti, asiakasnumero). Autoliike- ja leasingvarauksessa maksava
    // asiakas on kuitenkin YRITYS. Aiemmin mikä tahansa haun löytämä asiakas
    // ohitti asiakastyyppihaaran kokonaan, jolloin työtilaukseen linkittyi
    // yksityishenkilö vaikka tyypiksi oli valittu Autoliike — eikä autoliikettä
    // luotu lainkaan. Bugi oli olemassa jo ennen leasing/autoliike-tuen lisäystä.
    //
    // Nyt löydöstä käytetään maksajana vain jos sen oma asiakastyyppi on samalta
    // puolelta (henkilö vs. yritys) kuin varauksen tyyppi. Muussa tapauksessa se
    // hylätään ja asiakas haetaan/luodaan normaalia reittiä. Henkilön tiedot
    // tallentuvat joka tapauksessa kuljettajakenttiin, joten mitään ei häviä.
    //
    // Yksi ylimääräinen Airtable-luku, ja vain kun haku on löytänyt jotain.
    if (asiakasId) {
      const varausOnYritysmuotoinen = !!ASIAKASTYYPPI_KARTTA[omistajaTyyppi];
      let loydettyTyyppi = '';
      try {
        const loydetty = airtableGetById(TABLE_ASIAKKAAT, asiakasId);
        loydettyTyyppi = (loydetty && loydetty.fields && loydetty.fields['asiakastyyppi']) || '';
      } catch (e) {
        // Jos tarkistus epäonnistuu (verkkovirhe, poistettu rivi), ei kaadeta
        // koko varausta — luotetaan lomakkeen valintaan kuten ennenkin.
        Logger.log('Asiakastyypin tarkistus epäonnistui, käytetään löydöstä: ' + e.message);
        loydettyTyyppi = '';
      }

      const loytoOnYritysmuotoinen = loydettyTyyppi !== '' && loydettyTyyppi !== 'Yksityinen';

      if (loydettyTyyppi !== '' && varausOnYritysmuotoinen !== loytoOnYritysmuotoinen) {
        Logger.log('Löydetty asiakas ' + asiakasId + ' on tyyppiä "' + loydettyTyyppi +
          '" mutta varaus on "' + omistajaTyyppi + '" — hylätään ja haetaan oikea asiakas.');
        asiakasId = null;
      } else {
        Logger.log('Käytetään lomakkeelta vahvistettua asiakasId:tä: ' + asiakasId);
      }
    }

    if (asiakasId) {
      // Tyyppi täsmäsi tai tarkistusta ei voitu tehdä — ei haeta mitään.
    } else if (omistajaTyyppi === 'yksityinen') {
      const sahkoposti = data.sahkoposti || '';
      Logger.log('Etsitään asiakasta sähköpostilla: ' + sahkoposti);
      if (sahkoposti) {
        const olemassaoleva = airtableGet(TABLE_ASIAKKAAT, `{sähköposti}="${kaavaTeksti(sahkoposti)}"`);
        if (olemassaoleva) {
          asiakasId = olemassaoleva.id;
          Logger.log('Asiakas löytyi: ' + asiakasId);
        } else {
          const uusi = airtablePost(TABLE_ASIAKKAAT, {
            'sähköposti':    sahkoposti,
            'etunimi':       data.etunimi || '',
            'sukunimi':      data.sukunimi || '',
            'puhelin':       data.puhelin || '',
            'osoite':        data.osoite || '',
            'postinumero':   data.postinumero || '',
            'kaupunki':      data.kaupunki || '',
            'asiakastyyppi': 'Yksityinen',
            'Asiakasnumero': haeSeuraavaAsiakasnumero(),
            'tila':          'Aktiivinen',
          });
          asiakasId = uusi.id;
          Logger.log('Uusi asiakas luotu: ' + asiakasId);
        }
      } else {
        Logger.log('SAHKOPOSTI ON TYHJÄ — asiakasta ei luoda');
      }
    } else if (ASIAKASTYYPPI_KARTTA[omistajaTyyppi]) {
      // KORJAUS 24.8.2026: aiemmin tämä haara käsitteli VAIN 'yritys'-tyypin.
      // Lomakkeella on neljä vaihtoehtoa (yksityinen / yritys / leasing /
      // autoliike), joten leasing- ja autoliikevarauksista ei syntynyt
      // asiakasriviä lainkaan — yrityksen nimi, Y-tunnus, laskutusosoite ja
      // verkkolaskutiedot katosivat hiljaisesti, eikä työtilaukselle tullut
      // Asiakas-linkkiä. Ilman sitä työtä ei voi laskuttaa.
      //
      // Kaikki kolme käsitellään nyt samalla logiikalla, koska lomake käyttää
      // niille samoja syöttökenttiä (yritys-nimi, ytunnus, laskutusosoite...).
      // Ainoa ero on Airtableen kirjattava asiakastyyppi.
      const asiakastyyppi = ASIAKASTYYPPI_KARTTA[omistajaTyyppi];
      const ytunnus = String(data.ytunnus || '').trim();
      const yritysNimi = String(data.yritysNimi || '').trim();

      // Etsi ensin Y-tunnuksella (tarkin tunniste). Jos Y-tunnusta ei ole —
      // mikä on leasingissä tavallista — etsi yrityksen nimellä.
      let olemassaoleva = null;
      if (ytunnus) {
        olemassaoleva = airtableGet(TABLE_ASIAKKAAT, `{y-tunnus}="${kaavaTeksti(ytunnus)}"`);
      } else if (yritysNimi) {
        olemassaoleva = airtableGet(TABLE_ASIAKKAAT, `{yrityksen nimi}="${kaavaTeksti(yritysNimi)}"`);
      }

      if (olemassaoleva) {
        asiakasId = olemassaoleva.id;
        Logger.log('Yritysasiakas löytyi (' + asiakastyyppi + '): ' + asiakasId);
      } else if (ytunnus || yritysNimi) {
        // KORJAUS 24.8.2026: aiemmin asiakas luotiin VAIN jos Y-tunnus oli
        // annettu. Nyt riittää nimi — parempi tallentaa puutteellinen asiakas
        // kuin hukata tieto kokonaan. Puuttuvan Y-tunnuksen voi täydentää
        // jälkikäteen Airtablessa.
        const uusi = airtablePost(TABLE_ASIAKKAAT, {
          'yrityksen nimi':  yritysNimi,
          'y-tunnus':        ytunnus,
          'asiakastyyppi':   asiakastyyppi,
          'laskutusosoite':  data.laskutusosoite || '',
          'verkkolaskuosoite': data.verkkolasku || '',
          'verkkolaskuoperaattori': data.verkkolaskuOperaattori || '',
          'kustannuspaikka': data.kustannuspaikka || '',
          'Asiakasnumero':   haeSeuraavaAsiakasnumero(),
          'tila':            'Aktiivinen',
        });
        asiakasId = uusi.id;
        Logger.log('Uusi yritysasiakas luotu (' + asiakastyyppi + '): ' + asiakasId
          + (ytunnus ? '' : ' — HUOM: ilman Y-tunnusta'));
      } else {
        Logger.log('Yrityksen nimi ja Y-tunnus molemmat tyhjiä — asiakasta ei luoda');
      }
    }

    // UUSI 24.8.2026: maksajan puuttuminen tehdään näkyväksi.
    //
    // Taustaa: 24.8. tallentui autoliikevaraus ilman asiakaslinkkiä, eikä siitä
    // kerrottu missään. Vika löytyi vasta Airtablea selaamalla. Apps Scriptin
    // suorituslokia ei voi lukea web-app-ajoista, joten pelkkä Logger.log ei
    // riitä diagnostiikaksi.
    //
    // Nyt syy kirjataan työtilauksen Muokkaushistoriaan ja palautetaan
    // varoituksena lomakkeelle. Diagnoosi säilyy Airtablessa pysyvästi ja
    // kertoo täsmälleen mitä palvelin sai.
    let maksajaVaroitus = '';
    if (!asiakasId) {
      const osat = [
        'tyyppi=' + omistajaTyyppi,
        'nimi=' + (String(data.yritysNimi || '').trim() || 'tyhjä'),
        'y-tunnus=' + (String(data.ytunnus || '').trim() || 'tyhjä'),
        'sähköposti=' + (String(data.sahkoposti || '').trim() || 'tyhjä'),
        'asiakasId=' + (pyydettyAsiakasId || 'ei annettu'),
      ];
      maksajaVaroitus = 'Asiakasta ei ratkaistu (' + osat.join(', ') + ')';
      Logger.log(maksajaVaroitus);
    }

    Logger.log('asiakasId lopussa: ' + asiakasId);

    let autoId = null;
    const vin = data.vin || '';
    const rekisteri = data.rekisteri || '';

    if (vin) {
      const olemassaolevaAuto = airtableGet(TABLE_AUTOT, `{vin-tunniste}="${kaavaTeksti(vin)}"`);
      if (olemassaolevaAuto) {
        autoId = olemassaolevaAuto.id;
        const paivitykset = {};
        if (rekisteri && olemassaolevaAuto.fields['rekisterinumero'] !== rekisteri) {
          paivitykset['rekisterinumero'] = rekisteri;
        }
        if (data.merkki && !olemassaolevaAuto.fields['merkki']) {
          paivitykset['merkki'] = data.merkki;
        }
        if (data.malli && !olemassaolevaAuto.fields['malli']) {
          paivitykset['malli'] = data.malli;
        }
        if (Object.keys(paivitykset).length > 0) {
          airtablePatch(TABLE_AUTOT, autoId, paivitykset);
        }
      } else {
        let vanhaAuto = null;
        if (rekisteri) {
          vanhaAuto = airtableGet(TABLE_AUTOT, `{rekisterinumero}="${kaavaTeksti(rekisteri)}"`);
        }
        if (vanhaAuto && !vanhaAuto.fields['vin-tunniste']) {
          autoId = vanhaAuto.id;
          airtablePatch(TABLE_AUTOT, autoId, {
            'vin-tunniste': vin,
            'merkki':       data.merkki || vanhaAuto.fields['merkki'] || '',
            'malli':        data.malli || vanhaAuto.fields['malli'] || '',
            'vuosimalli':   data.vuosimalli ? parseInt(data.vuosimalli) : (vanhaAuto.fields['vuosimalli'] || null),
          });
        } else {
          const uusiAuto = airtablePost(TABLE_AUTOT, {
            'vin-tunniste':    vin,
            'rekisterinumero': rekisteri,
            'merkki':          data.merkki || '',
            'malli':           data.malli || '',
            'vuosimalli':      data.vuosimalli ? parseInt(data.vuosimalli) : null,
            'omistaja':        asiakasId ? [asiakasId] : [],
          });
          autoId = uusiAuto.id;
        }
      }
    } else if (rekisteri) {
      const olemassaolevaAuto = airtableGet(TABLE_AUTOT, `{rekisterinumero}="${kaavaTeksti(rekisteri)}"`);
      if (olemassaolevaAuto) {
        autoId = olemassaolevaAuto.id;
        const paivitykset = {};
        if (data.merkki && !olemassaolevaAuto.fields['merkki']) {
          paivitykset['merkki'] = data.merkki;
        }
        if (data.malli && !olemassaolevaAuto.fields['malli']) {
          paivitykset['malli'] = data.malli;
        }
        if (Object.keys(paivitykset).length > 0) {
          airtablePatch(TABLE_AUTOT, autoId, paivitykset);
        }
      } else {
        const uusiAuto = airtablePost(TABLE_AUTOT, {
          'rekisterinumero': rekisteri,
          'merkki':          data.merkki || '',
          'malli':           data.malli || '',
          'omistaja':        asiakasId ? [asiakasId] : [],
        });
        autoId = uusiAuto.id;
      }
    }

    Logger.log('autoId lopussa: ' + autoId);

    let lasiId = null;
    const eurokoodi = data.eurokoodi || '';

    if (eurokoodi && autoId) {
      const olemassaolevaLasi = airtableGet(TABLE_LASIT, `{eurokoodi}="${kaavaTeksti(eurokoodi)}"`);
      if (olemassaolevaLasi) {
        lasiId = olemassaolevaLasi.id;
        Logger.log('Lasi löytyi: ' + lasiId);
      } else {
        const uusiLasi = airtablePost(TABLE_LASIT, {
          'eurokoodi': eurokoodi,
        });
        lasiId = uusiLasi.id;
        Logger.log('Uusi lasi luotu: ' + lasiId);
      }
      if (lasiId) {
        const autoRecord = airtableGet(TABLE_AUTOT, `RECORD_ID()="${autoId}"`);
        const nykyisetLasit = (autoRecord && autoRecord.fields['Lasit']) ? autoRecord.fields['Lasit'] : [];
        if (!nykyisetLasit.includes(lasiId)) {
          nykyisetLasit.push(lasiId);
          airtablePatch(TABLE_AUTOT, autoId, { 'Lasit': nykyisetLasit });
          Logger.log('Lasi linkitetty autoon');
        }
      }
    }

    const tyyppiKestotByIdTallennusta = haeTyotyyppiKestot();
    const tyyppiId = haeTyotyyppiId(data.tyyppi || 'Muu', tyyppiKestotByIdTallennusta);
    const lisapalveluIdt = (data.lisapalvelut || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(n => haeTyotyyppiId(n, tyyppiKestotByIdTallennusta))
      .filter(Boolean);

    const tyotilausFields = {
      'asennuspiste/location': data.piste || '',
      'päivämäärä':            data.paivamaara || '',
      'kellonaika':            data.kellonaika || '',
      'tyyppi':                tyyppiId ? [tyyppiId] : [],
      'tila':                  'Varattu',
      'rekisterinumero':       rekisteri,
      'Lisätiedot':            data.viite || '',
      'Varaaja':               kirjautunutEmail || data.varaaja || '',
      'Hinta':                 data.hinta ? parseFloat(data.hinta) : null,
      'Lisäpalvelut':          lisapalveluIdt,
      'Leasing-yhtiö':               data.leasingYhtio || '',
      'Leasing-sopimusnumero':       data.leasingSopimus || '',
      'Leasing-lasiturva':           data.leasingLasiturva || '',
      'Kuljettajan nimi':            data.kuljettajaNimi || '',
      'Kuljettajan puhelin':         data.kuljettajaPuhelin || '',
      'Yhteyshenkilön sähköposti':   data.yhteyshenkiloEmail || '',
      'Työmääräysnumero':            data.tyomaarays || '',
      // UUSI 24.8.2026: autoliikkeen myyjä — se henkilö jolta auto noudetaan.
      // Eri henkilö kuin 'Kuljettajan nimi', joka tarkoittaa auton kuljettajaa
      // tai omistajaa (usein autoliikkeen asiakas, joka on jo ostanut auton).
      // Molemmat voivat olla täytettyinä samassa varauksessa.
      'Autoliikkeen yhteyshenkilö':  koostaMyyja(data),
      'Tarvikkeet':                  data.tarvikkeet || '',
      'Laskun tarkistus':      true,
      'Lasin hinta':           numeroTaiNull(data.hintaLasi),
      'Työn hinta':            numeroTaiNull(data.hintaTyo),
      'Tarvikkeiden hinta':    numeroTaiNull(data.hintaTarvikkeet),
      'Kalibroinnin hinta':    numeroTaiNull(data.hintaKalibrointi),
      'Varastopaikka':         String(data.varastopaikka || '').trim(),
    };

    if (asiakasId) tyotilausFields['Asiakas'] = [asiakasId];
    if (autoId)    tyotilausFields['auto']    = [autoId];

    const valittuAsentaja = String(data.asentajaId || '').trim();
    if (RECORD_ID_MUOTO.test(valittuAsentaja)) {
      tyotilausFields['Asentaja'] = [valittuAsentaja];
    } else if (valittuAsentaja) {
      Logger.log('HUOM: asentajaId ei ole kelvollinen record id, ohitetaan: ' + valittuAsentaja);
    }

    const tyotilaus = airtablePost(TABLE_TYOTILAUKSET, tyotilausFields);
    Logger.log('Työtilaus luotu: ' + tyotilaus.id);

    const nroArvo = tyotilaus.fields ? tyotilaus.fields['Nro'] : null;
    const numerot = laskeVarausnumero(nroArvo);
    airtablePatch(TABLE_TYOTILAUKSET, tyotilaus.id, {
      'varausnumero': numerot.varausnumero,
      'asiakaskoodi': numerot.asiakaskoodi,
    });
    Logger.log('Varausnumero: ' + numerot.varausnumero + ' / Asiakaskoodi: ' + numerot.asiakaskoodi);

    // LASKURIVIT 16.9.2026: varauslomakkeen uusi dynaaminen rivilista
    // (korvaa entisen lisäpalvelut-checkbox-ryhmän + yhden yhteishinnan).
    // Jokainen rivi kirjoitetaan omana Laskurivinä heti kun työtilauksen id
    // on tiedossa. Lähde="Varaus" koska rivi syntyi varauslomakkeella.
    // Hinta syötetään lomakkeella VEROLLISENA (sama periaate kuin muualla
    // järjestelmässä, esim. Lasin hinta), joten se muunnetaan verottomaksi
    // ennen tallennusta (Laskurivit-taulun Yksikköhinta on aina alv 0%).
    const ALV_KERROIN_LASKURIVIT = 1.255;
    const lomakkeenLaskurivit = Array.isArray(data.laskurivit) ? data.laskurivit : [];
    const SALLITUT_MAKSAJAT_LOMAKKEELTA = ['Asiakas', 'Vakuutusyhtiö', 'Leasing-yhtiö', 'Työnantaja', 'Käteinen/Kortti'];
    lomakkeenLaskurivit.forEach(rivi => {
      const nimike = String(rivi.nimike || '').trim();
      const hintaBrutto = numeroTaiNull(rivi.hinta);
      if (!nimike || hintaBrutto === null) return; // hiljaa ohitetaan puutteelliset rivit, ei kaadeta koko tallennusta
      const maksaja = SALLITUT_MAKSAJAT_LOMAKKEELTA.includes(rivi.maksaja) ? rivi.maksaja : 'Asiakas';
      try {
        airtablePost('Laskurivit', {
          'Nimike': nimike,
          'Työtilaus': [tyotilaus.id],
          'Määrä': 1,
          'Yksikköhinta (alv 0%)': hintaBrutto / ALV_KERROIN_LASKURIVIT,
          'ALV %': 25.5,
          'Maksaja': maksaja,
          'Lisääjä': kirjautunutEmail || '',
          'Lähde': 'Varaus',
          'Laskutettu': false,
        });
      } catch (laskuriviVirhe) {
        // Ei kaadeta koko varauksen tallennusta yhden rivin takia — kirjataan
        // vain näkyviin, jotta virhe huomataan eikä rivi katoa hiljaa.
        Logger.log('HUOM: Laskurivin lisäys epäonnistui (' + nimike + '): ' + laskuriviVirhe.message);
        lisaaMuokkausHistoriaan(tyotilaus.id, kirjautunutEmail || 'järjestelmä', '⚠️ Laskurivin lisäys epäonnistui: ' + nimike + ' — ' + laskuriviVirhe.message);
      }
    });

    // LASKURIVIT (VANHAT KENTAT) 17.9.2026, KORJATTU 18.9.2026: Lasi/Tyo/
    // Tarvikkeet/Kalibrointi -hintakentat ovat edelleen kaytossa rinnakkain
    // uuden rivilistan kanssa. Muunnetaan nekin omiksi Laskurikseen.
    // KORJAUS 18.9.2026 (Carlin pyynnöstä): Maksaja oli aiemmin AINA
    // kovakoodattu "Asiakas", vaikka varaukselle olisi valittu vakuutusyhtiö
    // — tämän takia esim. STM-2026-V00182:n Lasi/Työ/Tarvikkeet-rivit menivät
    // väärin asiakkaalle vahingosta huolimatta. Nyt: jos lomakkeella on
    // valittu vakuutusyhtiö (ei "Ei vakuutusta"), nämä neljä riviä menevät
    // oletuksena Vakuutusyhtiölle. Muuten (ei vakuutusta) käyttäytyminen on
    // ennallaan: Asiakas. Omavastuu ja mahdolliset Lisäpalvelut-rivit tulevat
    // erikseen uuden rivilistan kautta ja ovat siellä jo oletuksena Asiakas.
    const vakuutusyhtioValittuNain = !!(data['vakuutusyhtiö'] && data['vakuutusyhtiö'] !== 'Ei vakuutusta');
    const VANHAT_KENTAT_MAKSAJA = vakuutusyhtioValittuNain ? 'Vakuutusyhtiö' : 'Asiakas';
    const VANHAT_HINTAKENTAT = [
      { hinta: numeroTaiNull(data.hintaLasi),       nimike: 'Lasi' + (String(data.eurokoodi || '').trim() ? ' ' + String(data.eurokoodi).trim() : '') },
      { hinta: numeroTaiNull(data.hintaTyo),         nimike: 'Työ' },
      { hinta: numeroTaiNull(data.hintaTarvikkeet),  nimike: 'Tarvikkeet' },
      { hinta: numeroTaiNull(data.hintaKalibrointi), nimike: 'Kalibrointi' },
    ];
    VANHAT_HINTAKENTAT.forEach(rivi => {
      if (rivi.hinta === null) return; // kentta tyhja, ei laskurivia
      try {
        airtablePost('Laskurivit', {
          'Nimike': rivi.nimike,
          'Työtilaus': [tyotilaus.id],
          'Määrä': 1,
          'Yksikköhinta (alv 0%)': rivi.hinta / ALV_KERROIN_LASKURIVIT,
          'ALV %': 25.5,
          'Maksaja': VANHAT_KENTAT_MAKSAJA,
          'Lisääjä': kirjautunutEmail || '',
          'Lähde': 'Varaus',
          'Laskutettu': false,
        });
      } catch (vanhaKenttaVirhe) {
        Logger.log('HUOM: Vanhan hintakentän Laskurivin lisäys epäonnistui (' + rivi.nimike + '): ' + vanhaKenttaVirhe.message);
        lisaaMuokkausHistoriaan(tyotilaus.id, kirjautunutEmail || 'järjestelmä', '⚠️ Laskurivin lisäys epäonnistui: ' + rivi.nimike + ' — ' + vanhaKenttaVirhe.message);
      }
    });

    // Kirjataan maksajan puuttuminen vasta tässä, koska työtilauksen id on
    // olemassa vasta nyt. Ei kaadeta tallennusta jos kirjaus epäonnistuu —
    // lisaaMuokkausHistoriaan nielaisee omat virheensä.
    if (maksajaVaroitus) {
      lisaaMuokkausHistoriaan(tyotilaus.id, kirjautunutEmail || 'järjestelmä', maksajaVaroitus);
    }

    const vakuutusyhtioNimi = data['vakuutusyhtiö'] || '';
    if (vakuutusyhtioNimi && vakuutusyhtioNimi !== 'Ei vakuutusta') {
      let vakuutusyhtioId = null;
      const vy = airtableGet(TABLE_VAKUUTUSYHTIOT, `{yhtiön nimi}="${kaavaTeksti(vakuutusyhtioNimi)}"`);
      if (vy) {
        vakuutusyhtioId = vy.id;
      } else {
        Logger.log('HUOM: vakuutusyhtiötä ei löytynyt Vakuutusyhtiöt-taulusta: ' + vakuutusyhtioNimi);
      }

      const vakuutustapausFields = {
        'Työtilaus':               [tyotilaus.id],
        'Vahinkotunnus':           data.vahinkotunnus || '',
        'Vahinkopäivä':            data.vahinkopv || '',
        'Tila':                    'Ilmoitettu',
        'Omavastuu':               data.omavastuu ? parseFloat(data.omavastuu) : null,
        'ALV-vähennyskelpoinen':   data.alvAuto === 'Kyllä',
        'Leasing-ajoneuvo':        data.leasingAuto === 'Kyllä',
        'Vakuutus tarkistettu':    data.vakuutusTarkistettu === 'K',
        'Huomioita':               data.vakuutusHuomioita || '',
        'Laskutuslupatunnus':      String(data.laskutuslupatunnus || '').trim(),
        'Lasiturva voimassa':      (data.lasiturva === 'Kyllä' || data.lasiturva === 'Ei')
                                     ? data.lasiturva : 'Ei tarkistettu',
      };
      if (vakuutusyhtioId) {
        vakuutustapausFields['Vakuutusyhtiö'] = [vakuutusyhtioId];
      }

      const vakuutustapaus = airtablePost(TABLE_VAKUUTUSTAPAUKSET, vakuutustapausFields);
      Logger.log('Vakuutustapaus luotu: ' + (vakuutustapaus && vakuutustapaus.id));

      // OMAVASTUU LASKURIVEIKSI 18.9.2026 (Carlin pyynnöstä): Omavastuu ei
      // aiemmin tuottanut MITÄÄN laskuriviä — se oli vain tieto Vakuutus-
      // tapaus-tietueella, näkymätön kaikilla laskuilla. Nyt kun vakuutusyhtiö
      // on valittu ja Omavastuu-summa on annettu, kirjataan kaksi riviä:
      // asiakas maksaa omavastuun itse (+), ja sama summa vähennetään
      // vakuutusyhtiön laskusta (-), koska vakuutusyhtiö korvaa vain
      // omavastuun ylittävän osan. TARKOITUKSELLA EI VIELÄ ALV-jakoa
      // yritysautoille (ALV-vähennyskelpoinen-kenttä) — Carl päätti
      // 18.9.2026 että se tehdään omana isompana tehtävänä myöhemmin kaikille
      // riveille (Lasi/Työ/Tarvikkeet/Kalibrointi/Omavastuu) yhdessä.
      const omavastuuBrutto = numeroTaiNull(data.omavastuu);
      if (omavastuuBrutto !== null && omavastuuBrutto > 0) {
        const omavastuuNetto = omavastuuBrutto / ALV_KERROIN_LASKURIVIT;
        try {
          airtablePost('Laskurivit', {
            'Nimike': 'Omavastuu',
            'Työtilaus': [tyotilaus.id],
            'Määrä': 1,
            'Yksikköhinta (alv 0%)': omavastuuNetto,
            'ALV %': 25.5,
            'Maksaja': 'Asiakas',
            'Lisääjä': kirjautunutEmail || '',
            'Lähde': 'Varaus',
            'Laskutettu': false,
          });
          airtablePost('Laskurivit', {
            'Nimike': 'Omavastuu (vähennys vakuutuslaskusta)',
            'Työtilaus': [tyotilaus.id],
            'Määrä': 1,
            'Yksikköhinta (alv 0%)': -omavastuuNetto,
            'ALV %': 25.5,
            'Maksaja': 'Vakuutusyhtiö',
            'Lisääjä': kirjautunutEmail || '',
            'Lähde': 'Varaus',
            'Laskutettu': false,
          });
        } catch (omavastuuVirhe) {
          Logger.log('HUOM: Omavastuun Laskurivien lisäys epäonnistui: ' + omavastuuVirhe.message);
          lisaaMuokkausHistoriaan(tyotilaus.id, kirjautunutEmail || 'järjestelmä', '⚠️ Omavastuun laskurivien lisäys epäonnistui: ' + omavastuuVirhe.message);
        }
      }
    }

    const kalenteriTulos = luoKalenteritapahtuma({
      piste:          data.piste || 'TEST',
      paivamaara:     data.paivamaara,
      kellonaika:     data.kellonaika,
      kestoMinuuttia: 60,
      otsikko:        (data.tyyppi || 'Varaus') + ' - ' + (rekisteri || ''),
      kuvaus:         'Varausnumero: ' + numerot.varausnumero + (data.viite ? ('\n\n' + data.viite) : ''),
    });
    if (!kalenteriTulos.ok) {
      Logger.log('HUOM: kalenteritapahtuman luonti epäonnistui: ' + kalenteriTulos.error);
    } else {
      Logger.log('Kalenteritapahtuma luotu: ' + kalenteriTulos.linkki);
    }

    let smsDebug = 'smsTesti-arvo: ' + JSON.stringify(data.smsTesti) + ' (tyyppi: ' + typeof data.smsTesti + ')';
    if (data.smsTesti === true) {
      const smsNumero = data.puhelin || '';
      if (smsNumero) {
        const smsViesti = 'Varauksesi ' + numerot.asiakaskoodi + ' on vastaanotettu. STM Varauslomake -testiviesti.';
        const messtoVastaus = lahetaSMS(smsNumero, smsViesti);
        smsDebug += ' | Lähetetty numeroon ' + smsNumero + ' | MESSTO vastasi: ' + messtoVastaus;
      } else {
        smsDebug += ' | Puhelinnumero PUUTTUI, ei lähetetty';
      }
    } else {
      smsDebug += ' | smsTesti EI ollut true, ei yritetty lähettää';
    }
    Logger.log('SMS-DEBUG: ' + smsDebug);

    return {
      ok: true,
      id: tyotilaus.id,
      varausnumero: numerot.varausnumero,
      asiakaskoodi: numerot.asiakaskoodi,
      smsDebug: smsDebug,
      // UUSI 24.8.2026: tyhjä jos maksaja ratkesi. Varaus tallentuu silti —
      // tämä on varoitus, ei virhe. Lomake näyttää tekstin käyttäjälle.
      maksajaVaroitus: maksajaVaroitus,
    };

  } catch(err) {
    Logger.log('VIRHE: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function testWebhook() {
  const testData = {
    piste:         'TEST',
    paivamaara:    '2026-06-26',
    kellonaika:    '10:00',
    tyyppi:        'Vaihto',
    omistajaTyyppi: 'yksityinen',
    etunimi:       'Uusi',
    sukunimi:      'Testaaja',
    sahkoposti:    'uusi@testi.fi',
    puhelin:       '0401234567',
    rekisteri:     'UUS-999',
    vin:           '',
    merkki:        'Toyota',
    malli:         'Corolla',
    vuosimalli:    '2022',
    hinta:         '199.90',
    lisapalvelut:  'Pinnoitus, Sulat',
  };

  const tulos = suoritaVarauksenTallennus(testData, 'testWebhook (ei oikeaa kirjautumista)');
  Logger.log(JSON.stringify(tulos));
}

function debugKuvienMetatiedot() {
  const paakansio = DriveApp.getFolderById(DRIVE_KUVAT_FOLDER);
  const kansiot = paakansio.getFolders();
  let uusin = null, uusinAika = null;
  while (kansiot.hasNext()) {
    const k = kansiot.next();
    if (!uusinAika || k.getDateCreated() > uusinAika) {
      uusin = k;
      uusinAika = k.getDateCreated();
    }
  }
  if (!uusin) {
    Logger.log('Ei yhtään kuvakansiota löytynyt Kuvat-pääkansiosta.');
    return;
  }
  Logger.log('Uusin kuvakansio: ' + uusin.getName());

  const tiedostot = uusin.getFiles();
  let maara = 0;
  while (tiedostot.hasNext()) {
    const f = tiedostot.next();
    maara++;
    const resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + f.getId() + '?fields=name,properties',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
    );
    Logger.log(resp.getContentText());
  }
  Logger.log('Tarkistettu ' + maara + ' tiedostoa kansiosta ' + uusin.getName());
}

function debugKayttajat() {
  const kansio = DriveApp.getFolderById(DRIVE_DATA_FOLDER);
  const tiedostot = kansio.getFilesByName(DRIVE_KAYTTAJAT_FILE);
  let maara = 0;
  while (tiedostot.hasNext()) {
    const f = tiedostot.next();
    maara++;
    Logger.log('Tiedosto #' + maara + ': ' + f.getId());
    Logger.log('Sisältö: ' + f.getBlob().getDataAsString());
  }
  Logger.log('Löytyi yhteensä ' + maara + ' tiedostoa');
}

function haeTestiTyonId() {
  const rivi = airtableGet(TABLE_TYOTILAUKSET, `{asennuspiste/location}="TEST"`);
  if (!rivi) {
    Logger.log('Yhtään TEST-pisteen työtä ei löytynyt. Luo ensin testivaraus TEST-pisteelle index.html:llä.');
    return;
  }
  Logger.log('Löytyi TEST-työ, record ID: ' + rivi.id);
  Logger.log('Varausnumero: ' + (rivi.fields['varausnumero'] || '(ei vielä numeroa)'));
  Logger.log('Kopioi tämä ID testAlkutarkastus()-funktion testiTyoId-muuttujaan.');
}

function testAlkutarkastus() {
  const testiTyoId = 'rec0AvsaTf93Qz4RH';
  const testiTarkastukset = JSON.stringify({
    vikakoodit: new Date().toISOString(),
    suojaimet: new Date().toISOString(),
    suojaus: new Date().toISOString()
  });
  tallennaAlkutarkastus(testiTyoId, 'testi@stm.fi', testiTarkastukset);
  Logger.log('Testi suoritettu, tarkista Tarkastukset-taulu Airtablessa.');
}

function testaaIstunto() {
  const testiEmail = 'testi@stm.fi';
  const istuntoId = luoIstunto(testiEmail);
  const takaisinSaatuEmail = tarkistaIstunto(istuntoId);
  const vaarallaIdlla = tarkistaIstunto('tama-ei-ole-oikea-id');

  return 'Luotu istuntoId: ' + istuntoId
    + ' | Tarkistus oikealla ID:llä palautti: ' + takaisinSaatuEmail
    + ' | Tarkistus väärällä ID:llä palautti: ' + vaarallaIdlla
    + ' (pitäisi olla null)'
    + ' | TESTI ONNISTUI: ' + (takaisinSaatuEmail === testiEmail && vaarallaIdlla === null);
}

function testaaMesstoSMS() {
  const numero = '+358505505005';
  const viesti = 'Testiviesti STM Varauslomakkeelta';
  const vastaus = lahetaSMS(numero, viesti);
  return 'MESSTO vastasi: ' + vastaus;
}

function testaaKapasiteetti() {
  const piste = 'TEST';
  const paivamaara = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');
  const tulos = laskeKapasiteetti(piste, paivamaara);
  Logger.log(JSON.stringify(tulos, null, 2));
  return JSON.stringify(tulos, null, 2);
}

function debugPisteHaku() {
  const table = TABLE_PISTEET;
  const formula = '{Nimi}="TEST"';
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
    muteHttpExceptions: true
  });
  const koodi = resp.getResponseCode();
  const teksti = resp.getContentText();
  Logger.log('URL: ' + url);
  Logger.log('HTTP-koodi: ' + koodi);
  Logger.log('Vastauksen alku (max 500 merkkiä): ' + teksti.substring(0, 500));
  return 'HTTP ' + koodi + ' — katso Logger.log yllä täydellinen vastaus';
}

function testaaAsiakasnumero() {
  const seuraava = haeSeuraavaAsiakasnumero();
  Logger.log('Seuraava Asiakasnumero olisi: ' + seuraava);
  return 'Seuraava Asiakasnumero: ' + seuraava;
}

const STM_NIMI          = 'Suomen Tuulilasimestarit Oy';
const STM_YTUNNUS       = '3109434-5';
const STM_KATUOSOITE    = 'Vehmaantie 14';
const STM_POSTINUMERO   = '33470';
const STM_KAUPUNKI      = 'Ylöjärvi';
const STM_IBAN          = 'FI5655370120169777';

const FINVOICE_ROWACTIONCODE_LASITYO = '1120118';

const FINVOICE_VAHINKOLAJI_KOODIT = {
  'Lasi': '1170006',
  'Törmäys': '1170001',
  'Varkaus': '1170002',
  'Palo': '1170003',
  'Liikenne': '1170004',
  'Ilkivalta': '1170008',
  'Hirvi': '1170009',
  'Poro': '1170010',
  'Vastuu': '1170011',
  'Kuljetus': '1170012',
  'Muut': '1170013',
  'Eläin': '1170014',
  'Pysäköinti': '1170015',
  'Luonnonilmiö': '1170016',
  'Rikkoutuminen': '1170021',
  'Murto': '1170022',
  'Autopalvelu': '1170023',
  'Kasko': '1170030',
};

function xmlEscape(teksti) {
  return String(teksti || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function finvoicePvm(pvmStr) {
  if (!pvmStr) return '';
  return String(pvmStr).replace(/-/g, '').slice(0, 8);
}

function haeVakuutustapausTyolle(tyoId) {
  const kaikki = airtableListAll(TABLE_VAKUUTUSTAPAUKSET, 'TRUE()', null, null);
  return kaikki.find(vt => (vt.fields['Työtilaus'] || []).includes(tyoId)) || null;
}

function luoFinvoiceXml(tyoId) {
  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
  if (!tyoRecord) {
    return { ok: false, error: 'Työtilausta ei löytynyt: ' + tyoId };
  }
  const tf = tyoRecord.fields;

  const vakuutusRivi = haeVakuutustapausTyolle(tyoId);
  if (!vakuutusRivi) {
    return { ok: false, error: 'Työllä ei ole vakuutustapausta — Finvoice-lasku on tarkoitettu vain vakuutuslaskuille.' };
  }
  const vf = vakuutusRivi.fields;

  let vakuutusyhtioNimi = '';
  const vyIds = vf['Vakuutusyhtiö'] || [];
  if (vyIds.length > 0) {
    const vyRecord = airtableGetById(TABLE_VAKUUTUSYHTIOT, vyIds[0]);
    if (vyRecord) vakuutusyhtioNimi = vyRecord.fields['yhtiön nimi'] || '';
  }
  if (!vakuutusyhtioNimi) {
    return { ok: false, error: 'Vakuutusyhtiön nimeä ei löytynyt.' };
  }

  let asiakas = null;
  const asiakasIds = tf['Asiakas'] || [];
  if (asiakasIds.length > 0) {
    const asiakasRecord = airtableGetById(TABLE_ASIAKKAAT, asiakasIds[0]);
    if (asiakasRecord) asiakas = asiakasRecord.fields;
  }
  if (!asiakas) {
    return { ok: false, error: 'Asiakasta (työn tilaajaa) ei löytynyt.' };
  }

  let auto = null;
  const autoIds = tf['auto'] || [];
  if (autoIds.length > 0) {
    const autoRecord = airtableGetById(TABLE_AUTOT, autoIds[0]);
    if (autoRecord) auto = autoRecord.fields;
  }

  const tyyppiKestotById = haeTyotyyppiKestot();
  const tyyppiLinkit = tf['tyyppi'] || [];
  const lisapalveluLinkit = tf['Lisäpalvelut'] || [];

  // LASKURIVIT 16.9.2026: Finvoice-lasku käyttää nyt Laskurivit-taulun
  // rivejä, joilla Maksaja = "Vakuutusyhtiö" — ei enää lasketa/jaeta
  // kokonaishintaa keinotekoisesti tyyppien kesken. PAKOTTAA uuden
  // järjestelmän käyttöön: jos sopivia rivejä ei löydy, ei käytetä
  // vanhaa laskeTyonKokonaishinta-mallia vaan palautetaan virhe.
  const kaikkiLaskurivitTyolle = haeKaikkiLaskurivitTyolle(tyoId);
  const vakuutusLaskurivit = kaikkiLaskurivitTyolle.filter(r => r.fields['Maksaja'] === 'Vakuutusyhtiö');

  if (vakuutusLaskurivit.length === 0) {
    return { ok: false, error: 'Työltä puuttuu vakuutusyhtiölle osoitetut laskurivit (Laskurivit-taulu) — ei voida muodostaa Finvoice-laskua.' };
  }

  // rowActionCode haetaan Nimikkeen perusteella Työtyypit-taulusta, koska
  // Laskurivit ei itsessään sisällä RowActionCode-tietoa — Nimike on
  // vapaa tekstikenttä, joten haku tehdään nimen täsmäyksellä. Jos
  // täsmäystä ei löydy, käytetään yleistä lasityön oletuskoodia.
  const rowActionCodeNimella = {};
  Object.keys(tyyppiKestotById).forEach(id => {
    const t = tyyppiKestotById[id];
    if (t && t.nimi) rowActionCodeNimella[t.nimi] = t.rowActionCode;
  });

  const omavastuu = parseFloat(vf['Omavastuu']) || 0;
  const ALV_PROSENTTI = 25.5;

  // Jokainen Laskurivi tuottaa oman InvoiceRow-elementtinsä suoraan
  // tallennetulla hinnalla — ei enää jakoa/pyöristystä usealle riville,
  // koska jokaisella rivillä on jo oma tarkka Yksikköhinta (alv 0%).
  let invoiceRowsXml = '';
  let laskunNettoYhteensa = 0;
  let laskunAlvYhteensa = 0;

  vakuutusLaskurivit.forEach(rivi => {
    const nimike = rivi.fields['Nimike'] || '';
    const maara = rivi.fields['Määrä'] || 1;
    const nettoPerRivi = parseFloat(rivi.fields['Yksikköhinta (alv 0%)']) || 0;
    const rivinAlvProsentti = rivi.fields['ALV %'] || ALV_PROSENTTI;
    const alvPerRivi = nettoPerRivi * (rivinAlvProsentti / 100);
    const rowActionCode = rowActionCodeNimella[nimike] || FINVOICE_ROWACTIONCODE_LASITYO;

    invoiceRowsXml += `  <InvoiceRow>
    <ArticleIdentifier>${xmlEscape(nimike)}</ArticleIdentifier>
    <ArticleName>${xmlEscape(nimike)}</ArticleName>
    <DeliveredQuantity QuantityUnitCode="kpl">${maara}</DeliveredQuantity>
    <UnitPriceAmount AmountCurrencyIdentifier="EUR">${nettoPerRivi.toFixed(2)}</UnitPriceAmount>
    <RowVatRatePercent>${rivinAlvProsentti}</RowVatRatePercent>
    <RowVatAmount AmountCurrencyIdentifier="EUR">${alvPerRivi.toFixed(2)}</RowVatAmount>
    <RowVatExcludedAmount AmountCurrencyIdentifier="EUR">${nettoPerRivi.toFixed(2)}</RowVatExcludedAmount>
    <RowAmount AmountCurrencyIdentifier="EUR">${nettoPerRivi.toFixed(2)}</RowAmount>
    <RowActionCode>${rowActionCode}</RowActionCode>
  </InvoiceRow>
`;
    laskunNettoYhteensa += nettoPerRivi * maara;
    laskunAlvYhteensa += alvPerRivi * maara;
  });

  const laskunBruttoYhteensa = laskunNettoYhteensa + laskunAlvYhteensa;

  let definitionDetailsXml = '';
  if (auto) {
    if (auto['merkki']) {
      definitionDetailsXml += `  <DefinitionDetails>
    <DefinitionHeaderText DefinitionCode="1130141">Merkki</DefinitionHeaderText>
    <DefinitionValue>${xmlEscape(auto['merkki'])}</DefinitionValue>
  </DefinitionDetails>
`;
    }
    if (auto['malli']) {
      definitionDetailsXml += `  <DefinitionDetails>
    <DefinitionHeaderText DefinitionCode="1130142">Malli</DefinitionHeaderText>
    <DefinitionValue>${xmlEscape(auto['malli'])}</DefinitionValue>
  </DefinitionDetails>
`;
    }
    if (auto['vuosimalli']) {
      definitionDetailsXml += `  <DefinitionDetails>
    <DefinitionHeaderText DefinitionCode="1130143">Vuosimalli</DefinitionHeaderText>
    <DefinitionValue>${xmlEscape(auto['vuosimalli'])}</DefinitionValue>
  </DefinitionDetails>
`;
    }
  }

  const vahinkolajiNimi = vf['Vahinkolaji'] || 'Lasi';
  const vahinkolajiKoodi = FINVOICE_VAHINKOLAJI_KOODIT[vahinkolajiNimi] || FINVOICE_VAHINKOLAJI_KOODIT['Lasi'];
  definitionDetailsXml += `  <DefinitionDetails>
    <DefinitionHeaderText DefinitionCode="1138242">Vahinkolaji</DefinitionHeaderText>
    <DefinitionValue QuantityUnitCode="${vahinkolajiKoodi}">${xmlEscape(vahinkolajiNimi)}</DefinitionValue>
  </DefinitionDetails>
`;

  if (omavastuu > 0) {
    definitionDetailsXml += `  <DefinitionDetails>
    <DefinitionHeaderText DefinitionCode="1138231">Omavastuu</DefinitionHeaderText>
    <DefinitionValue QuantityUnitCode="EUR">${omavastuu.toFixed(2)}</DefinitionValue>
  </DefinitionDetails>
`;
  }

  let asiakasNimi = '';
  if (asiakas['asiakastyyppi'] === 'Yritys') {
    asiakasNimi = asiakas['yrityksen nimi'] || '';
  } else {
    asiakasNimi = [asiakas['etunimi'], asiakas['sukunimi']].filter(Boolean).join(' ');
  }

  const invoiceDate = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');
  const dueDate = Utilities.formatDate(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), 'Europe/Helsinki', 'yyyy-MM-dd'
  ); // 14 vrk maksuaika, testiarvo

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Finvoice Version="3.0">
<SellerPartyDetails>
  <SellerPartyIdentifier>${xmlEscape(STM_YTUNNUS)}</SellerPartyIdentifier>
  <SellerOrganisationName>${xmlEscape(STM_NIMI)}</SellerOrganisationName>
  <SellerOrganisationTaxCode>FI${STM_YTUNNUS.replace('-', '')}</SellerOrganisationTaxCode>
  <SellerPostalAddressDetails>
    <SellerStreetName>${xmlEscape(STM_KATUOSOITE)}</SellerStreetName>
    <SellerTownName>${xmlEscape(STM_KAUPUNKI)}</SellerTownName>
    <SellerPostCodeIdentifier>${xmlEscape(STM_POSTINUMERO)}</SellerPostCodeIdentifier>
    <CountryCode>FI</CountryCode>
    <CountryName>Finland</CountryName>
  </SellerPostalAddressDetails>
</SellerPartyDetails>
<InvoiceRecipientPartyDetails>
  <InvoiceRecipientOrganisationName>${xmlEscape(vakuutusyhtioNimi)}</InvoiceRecipientOrganisationName>
</InvoiceRecipientPartyDetails>
<BuyerPartyDetails>
  <BuyerOrganisationName>${xmlEscape(asiakasNimi)}</BuyerOrganisationName>
  <BuyerPostalAddressDetails>
    <BuyerStreetName>${xmlEscape(asiakas['osoite'] || '')}</BuyerStreetName>
    <BuyerTownName>${xmlEscape(asiakas['kaupunki'] || '')}</BuyerTownName>
    <BuyerPostCodeIdentifier>${xmlEscape(asiakas['postinumero'] || '')}</BuyerPostCodeIdentifier>
    <CountryCode>FI</CountryCode>
    <CountryName>Finland</CountryName>
  </BuyerPostalAddressDetails>
</BuyerPartyDetails>
<InvoiceDetails>
  <InvoiceTypeCode CodeListAgencyIdentifier="SPY">INV01</InvoiceTypeCode>
  <InvoiceTypeText>LASKU</InvoiceTypeText>
  <InvoiceNumber>${xmlEscape(tf['varausnumero'] || '')}</InvoiceNumber>
  <InvoiceDate Format="CCYYMMDD">${finvoicePvm(invoiceDate)}</InvoiceDate>
  <SellerReferenceIdentifier>${xmlEscape(tf['asiakaskoodi'] || '')}</SellerReferenceIdentifier>
  <NotificationIdentifier>${xmlEscape(vf['Vahinkotunnus'] || '')}</NotificationIdentifier>
  <AgreementIdentifier>${xmlEscape(vf['Vakuutustunnus'] || '')}</AgreementIdentifier>
  <NotificationDate Format="CCYYMMDD">${finvoicePvm(vf['Vahinkopäivä'])}</NotificationDate>
  <RegistrationNumberIdentifier>${xmlEscape(tf['rekisterinumero'] || '')}</RegistrationNumberIdentifier>
${definitionDetailsXml}  <InvoiceTotalVatExcludedAmount AmountCurrencyIdentifier="EUR">${laskunNettoYhteensa.toFixed(2)}</InvoiceTotalVatExcludedAmount>
  <InvoiceTotalVatAmount AmountCurrencyIdentifier="EUR">${laskunAlvYhteensa.toFixed(2)}</InvoiceTotalVatAmount>
  <InvoiceTotalVatIncludedAmount AmountCurrencyIdentifier="EUR">${laskunBruttoYhteensa.toFixed(2)}</InvoiceTotalVatIncludedAmount>
</InvoiceDetails>
<InvoiceVatSpecificationDetails>
  <VatBaseAmount AmountCurrencyIdentifier="EUR">${laskunNettoYhteensa.toFixed(2)}</VatBaseAmount>
  <VatRatePercent>${ALV_PROSENTTI}</VatRatePercent>
  <VatRateAmount AmountCurrencyIdentifier="EUR">${laskunAlvYhteensa.toFixed(2)}</VatRateAmount>
</InvoiceVatSpecificationDetails>
${invoiceRowsXml}<EpiDetails>
  <EpiIdentificationDetails>
    <EpiDate Format="CCYYMMDD">${finvoicePvm(invoiceDate)}</EpiDate>
  </EpiIdentificationDetails>
  <EpiPartyDetails>
    <EpiBfiPartyDetails>
      <EpiBfiIdentifier>${xmlEscape(STM_IBAN)}</EpiBfiIdentifier>
    </EpiBfiPartyDetails>
    <EpiBeneficiaryPartyDetails>
      <EpiNameAddressDetails>${xmlEscape(STM_NIMI)}</EpiNameAddressDetails>
      <EpiBei>${xmlEscape(STM_IBAN)}</EpiBei>
      <EpiAccountID IdentificationSchemeName="IBAN">${xmlEscape(STM_IBAN)}</EpiAccountID>
    </EpiBeneficiaryPartyDetails>
  </EpiPartyDetails>
  <EpiPaymentInstructionDetails>
    <EpiRemittanceInfoIdentifier>${xmlEscape(tf['varausnumero'] || '')}</EpiRemittanceInfoIdentifier>
    <EpiInstructedAmount AmountCurrencyIdentifier="EUR">${laskunBruttoYhteensa.toFixed(2)}</EpiInstructedAmount>
    <EpiDateOptionDate Format="CCYYMMDD">${finvoicePvm(dueDate)}</EpiDateOptionDate>
  </EpiPaymentInstructionDetails>
</EpiDetails>
</Finvoice>`;

  return { ok: true, xml: xml };
}

// VAKUUTUS-PDF 17.9.2026: kevyt korvike Finvoice-verkkolaskun lähetykselle,
// koska varsinaista lähetyskanavaa (operaattori/Innovoice) ei ole käytössä.
// Tekee selkeän PDF-laskun ja tallentaa sen Google Driveen. EI lähetä
// mitään vakuutusyhtiölle — ihminen hakee PDF:n Drivesta ja lähettää
// eteenpäin haluamallaan tavalla.
function haeTaiLuoVakuutuslaskuKansio() {
  const props = PropertiesService.getScriptProperties();
  const tallennettuId = props.getProperty('VAKUUTUSLASKUT_KANSIO_ID');
  if (tallennettuId) {
    try {
      return DriveApp.getFolderById(tallennettuId);
    } catch (e) {
      // kansio poistettu/siirretty Drivessa — luodaan uusi alle
    }
  }
  const kansio = DriveApp.createFolder('Vakuutuslaskut (STM Varauslomake)');
  props.setProperty('VAKUUTUSLASKUT_KANSIO_ID', kansio.getId());
  return kansio;
}

function luoVakuutusPdf(tyoId) {
  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
  if (!tyoRecord) return { ok: false, error: 'Työtilausta ei löytynyt: ' + tyoId };
  const tf = tyoRecord.fields;

  const vakuutusRivi = haeVakuutustapausTyolle(tyoId);
  if (!vakuutusRivi) return { ok: false, error: 'Työllä ei ole vakuutustapausta.' };
  const vf = vakuutusRivi.fields;

  let vakuutusyhtioNimi = '';
  const vyIds = vf['Vakuutusyhtiö'] || [];
  if (vyIds.length > 0) {
    const vyRecord = airtableGetById(TABLE_VAKUUTUSYHTIOT, vyIds[0]);
    if (vyRecord) vakuutusyhtioNimi = vyRecord.fields['yhtiön nimi'] || '';
  }

  let asiakas = null;
  const asiakasIds = tf['Asiakas'] || [];
  if (asiakasIds.length > 0) {
    const asiakasRecord = airtableGetById(TABLE_ASIAKKAAT, asiakasIds[0]);
    if (asiakasRecord) asiakas = asiakasRecord.fields;
  }

  let auto = null;
  const autoIds = tf['auto'] || [];
  if (autoIds.length > 0) {
    const autoRecord = airtableGetById(TABLE_AUTOT, autoIds[0]);
    if (autoRecord) auto = autoRecord.fields;
  }

  const vakuutusLaskurivit = haeKaikkiLaskurivitTyolle(tyoId).filter(r => r.fields['Maksaja'] === 'Vakuutusyhtiö');
  if (vakuutusLaskurivit.length === 0) {
    return { ok: false, error: 'Työltä puuttuu vakuutusyhtiölle osoitetut laskurivit.' };
  }

  let nettoYht = 0, alvYht = 0;
  const rivitHtml = vakuutusLaskurivit.map(r => {
    const maara = r.fields['Määrä'] || 1;
    const netto = parseFloat(r.fields['Yksikköhinta (alv 0%)']) || 0;
    const alvP = r.fields['ALV %'] || 25.5;
    const alv = netto * maara * (alvP / 100);
    nettoYht += netto * maara;
    alvYht += alv;
    return '<tr>' +
      '<td>' + xmlEscape(r.fields['Nimike'] || '') + '</td>' +
      '<td style="text-align:right;">' + maara + '</td>' +
      '<td style="text-align:right;">' + netto.toFixed(2) + ' €</td>' +
      '<td style="text-align:right;">' + alvP + ' %</td>' +
      '<td style="text-align:right;">' + (netto * maara).toFixed(2) + ' €</td>' +
      '</tr>';
  }).join('');
  const bruttoYht = nettoYht + alvYht;

  const asiakasNimi = asiakas
    ? (asiakas['asiakastyyppi'] === 'Yritys' ? (asiakas['yrityksen nimi'] || '') : [asiakas['etunimi'], asiakas['sukunimi']].filter(Boolean).join(' '))
    : '';
  const autoTeksti = auto ? [auto['merkki'], auto['malli'], auto['vuosimalli']].filter(Boolean).join(' ') : '';
  const pvm = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'd.M.yyyy');

  const html = '<html><body style="font-family:Arial,sans-serif;font-size:12px;color:#111;padding:24px;">' +
    '<h2 style="margin-bottom:0;">' + xmlEscape(STM_NIMI) + '</h2>' +
    '<p style="margin-top:2px;color:#555;">Y-tunnus ' + xmlEscape(STM_YTUNNUS) + ' · ' + xmlEscape(STM_KATUOSOITE) + ', ' + xmlEscape(STM_POSTINUMERO) + ' ' + xmlEscape(STM_KAUPUNKI) + '</p>' +
    '<hr>' +
    '<table style="width:100%;margin-top:12px;"><tr>' +
    '<td style="vertical-align:top;width:50%;"><b>Laskutettava</b><br>' + xmlEscape(vakuutusyhtioNimi) + '</td>' +
    '<td style="vertical-align:top;"><b>Vahinkotiedot</b><br>' +
    'Varausnumero: ' + xmlEscape(tf['varausnumero'] || '') + '<br>' +
    'Asiakaskoodi: ' + xmlEscape(tf['asiakaskoodi'] || '') + '<br>' +
    'Rekisterinumero: ' + xmlEscape(tf['rekisterinumero'] || '') + '<br>' +
    'Vahinkotunnus: ' + xmlEscape(vf['Vahinkotunnus'] || '') + '<br>' +
    'Vakuutustunnus: ' + xmlEscape(vf['Vakuutustunnus'] || '') + '<br>' +
    'Omavastuu: ' + (parseFloat(vf['Omavastuu']) || 0).toFixed(2) + ' €<br>' +
    'Päivämäärä: ' + pvm +
    '</td></tr></table>' +
    '<p><b>Asiakas / auto:</b> ' + xmlEscape(asiakasNimi) + ' — ' + xmlEscape(autoTeksti) + '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin-top:12px;">' +
    '<tr style="background:#eee;"><th style="text-align:left;padding:4px;">Nimike</th>' +
    '<th style="text-align:right;padding:4px;">Määrä</th>' +
    '<th style="text-align:right;padding:4px;">á-hinta (alv 0%)</th>' +
    '<th style="text-align:right;padding:4px;">ALV</th>' +
    '<th style="text-align:right;padding:4px;">Yhteensä (alv 0%)</th></tr>' +
    rivitHtml +
    '</table>' +
    '<table style="width:100%;margin-top:8px;">' +
    '<tr><td style="text-align:right;">Yhteensä (alv 0%):</td><td style="text-align:right;width:100px;">' + nettoYht.toFixed(2) + ' €</td></tr>' +
    '<tr><td style="text-align:right;">ALV:</td><td style="text-align:right;">' + alvYht.toFixed(2) + ' €</td></tr>' +
    '<tr><td style="text-align:right;"><b>Yhteensä:</b></td><td style="text-align:right;"><b>' + bruttoYht.toFixed(2) + ' €</b></td></tr>' +
    '</table>' +
    '<p style="margin-top:20px;color:#888;font-size:10px;">Tämä PDF on sisäinen tuki laskutukselle — ei automaattisesti lähetetty vakuutusyhtiölle.</p>' +
    '</body></html>';

  const pdfBlob = Utilities.newBlob(html, 'text/html', 'vakuutuslasku.html').getAs('application/pdf');
  const tiedostonimi = 'Vakuutuslasku_' + (tf['varausnumero'] || tyoId) + '_' + (tf['rekisterinumero'] || '') + '.pdf';
  pdfBlob.setName(tiedostonimi);

  const kansio = haeTaiLuoVakuutuslaskuKansio();
  const tiedosto = kansio.createFile(pdfBlob);

  return { ok: true, tiedostoId: tiedosto.getId(), tiedostoUrl: tiedosto.getUrl(), tiedostonimi: tiedostonimi };
}

// FINVOICE-TIEDOSTO 18.9.2026 — sama Drive-kansio kuin PDF, mutta
// Finvoice-XML-muodossa (luoFinvoiceXml oli jo olemassa mutta ei
// koskaan kytketty mihinkään sitä tuottavaan reittiin). EI lähde
// mihinkään operaattorille automaattisesti, sama periaate kuin PDF:llä
// — vain tallennetaan Driveen odottamaan (Carlin päätös 18.9.2026).
function luoVakuutusFinvoice(tyoId) {
  const xmlTulos = luoFinvoiceXml(tyoId);
  if (!xmlTulos.ok) return xmlTulos;

  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
  const tf = tyoRecord ? tyoRecord.fields : {};
  const tiedostonimi = 'Finvoice_' + (tf['varausnumero'] || tyoId) + '_' + (tf['rekisterinumero'] || '') + '.xml';

  const xmlBlob = Utilities.newBlob(xmlTulos.xml, 'application/xml', tiedostonimi);
  const kansio = haeTaiLuoVakuutuslaskuKansio();
  const tiedosto = kansio.createFile(xmlBlob);

  return { ok: true, tiedostoId: tiedosto.getId(), tiedostoUrl: tiedosto.getUrl(), tiedostonimi: tiedostonimi };
}

// TESTIFUNKTIO — aja ▶-napista Apps Script -editorissa KERRAN deployn
// jälkeen. Tämä myös laukaisee Google-luvan pyynnön Drive-käytölle.
function testaaVakuutusPdf() {
  const tyoRivi = airtableGet(TABLE_TYOTILAUKSET, `{varausnumero}="STM-2026-V00145"`);
  if (!tyoRivi) {
    Logger.log('Ei löytynyt testityötä. Anna toinen varausnumero jolla on vakuutustapaus + Vakuutusyhtiö-laskurivejä.');
    return 'Ei testidataa saatavilla.';
  }
  const tulos = luoVakuutusPdf(tyoRivi.id);
  Logger.log(JSON.stringify(tulos, null, 2));
  return JSON.stringify(tulos, null, 2);
}

// TESTIFUNKTIO 18.9.2026 — testaa molemmat laskutusreitit (Fennoa +
// vakuutus-PDF/Finvoice) yhdellä ajolla samalle työlle, ilman että
// tarvitsee merkitä työtä uudelleen valmiiksi asentajanäkymässä.
// Muuta varausnumero tarpeen mukaan.
function testaaMolemmatLaskutusreitit() {
  const varausnumero = 'STM-2026-V00182';
  const tyoRivi = airtableGet(TABLE_TYOTILAUKSET, `{varausnumero}="${varausnumero}"`);
  if (!tyoRivi) {
    Logger.log('Ei löytynyt työtä ' + varausnumero);
    return 'Ei testidataa saatavilla.';
  }
  const id = tyoRivi.id;
  const onkoAsiakas = (tyoRivi.fields['Asiakas'] || []).length > 0;
  const onkoVakuutustapaus = !!haeVakuutustapausTyolle(id);
  const kaikkiRivit = haeKaikkiLaskurivitTyolle(id);
  const eiVakuutusRivit = kaikkiRivit.filter(r => r.fields['Maksaja'] !== 'Vakuutusyhtiö');
  const vakuutusRivit = kaikkiRivit.filter(r => r.fields['Maksaja'] === 'Vakuutusyhtiö');

  const tulokset = { onkoAsiakas, onkoVakuutustapaus, eiVakuutusRiviMaara: eiVakuutusRivit.length, vakuutusRiviMaara: vakuutusRivit.length };

  if (onkoAsiakas && eiVakuutusRivit.length > 0) {
    tulokset.fennoa = lahetaFennoaLasku(id);
  }
  if (onkoVakuutustapaus && vakuutusRivit.length > 0) {
    tulokset.vakuutusPdf = luoVakuutusPdf(id);
    tulokset.vakuutusFinvoice = luoVakuutusFinvoice(id);
    tulokset.vakuutusFennoa = luoVakuutusFennoaLasku(id);
  }
  Logger.log(JSON.stringify(tulokset, null, 2));
  return JSON.stringify(tulokset, null, 2);
}

// FENNOA-INTEGRAATIO 26.8.2026 — MYYNTILASKUJEN LÄHETYS (EI-VAKUUTUSLASKUT)
//
// TÄRKEÄ RAJAUS: Fennoa on tarkoitettu MUULLE laskutukselle kuin
// vakuutusyhtiölaskuille — yksityisasiakkaat, yritykset, leasing.
// Vakuutusyhtiölaskut menevät ERI reittiä (Innovoice, Finvoice-XML,
// ks. luoFinvoiceXml-funktio) — näitä kahta ei sekoiteta.
//
// VAHVISTETTU FENNOAN INTEGRAATIOPÄÄLLIKÖLTÄ (Niina Kataja) 28.8.2026:
// - Autentikointi: HTTP Basic Authentication, User=API-käyttäjätunnus,
//   Password=API-avain (EI POST-kentissä kuten alun perin arveltiin)
// - Base URL on sama testi- ja tuotantoympäristölle: https://app.fennoa.com/api
//   (ympäristö määräytyy pelkästään tunnusten mukaan, ei URL:sta)
// - Datamuoto: JSON kelpaa (dokumentaatio mainitsee FORM DATA:n, mutta
//   Fennoa vahvisti JSON:in toimivan samoilla kenttänimillä)
// - Testiympäristön API-käyttäjän rooli: "Kirjanpitäjä ilman maksuoikeutta"
// - Yhteystestiin sopiva kevyt endpoint: GET /customer_api (listaa asiakkaat)
const FENNOA_BASE_URL = 'https://app.fennoa.com/api';

function haeFennoaTunnukset() {
  const props = PropertiesService.getScriptProperties();
  const kayttaja = props.getProperty('FENNOA_API_ID');
  const avain = props.getProperty('FENNOA_API_KEY');
  if (!kayttaja || !avain) {
    throw new Error(
      'FENNOA_API_ID tai FENNOA_API_KEY puuttuu Script Propertiesista. ' +
      'Lisää molemmat: Apps Script -editori -> Project Settings -> Script Properties.'
    );
  }
  return { kayttaja: kayttaja, avain: avain };
}

function fennoaAuthHeader() {
  const t = haeFennoaTunnukset();
  const perus64 = Utilities.base64Encode(t.kayttaja + ':' + t.avain);
  return 'Basic ' + perus64;
}

// YHTEYSTESTI — aja tämä ENSIN Apps Script -editorissa manuaalisesti
// (▶-nappi), ennen laskun lähetyksen testaamista. Tarkistaa vain että
// Basic Auth -tunnukset toimivat, ei luo mitään Fennoaan.
function testaaFennoaYhteys() {
  try {
    const resp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/customer_api', {
      method: 'GET',
      headers: { 'Authorization': fennoaAuthHeader() },
      muteHttpExceptions: true
    });
    const koodi = resp.getResponseCode();
    const teksti = resp.getContentText();
    Logger.log('Fennoa-yhteystesti HTTP ' + koodi + ': ' + teksti.slice(0, 500));
    return 'HTTP ' + koodi + ' — katso Logger.log yllä täydellinen vastaus';
  } catch (err) {
    Logger.log('Fennoa-yhteystesti epäonnistui: ' + err.message);
    return 'VIRHE: ' + err.message;
  }
}

// LASKURIVIT 16.9.2026 — hakee Laskurivit-taulusta kaikki rivit tälle
// työlle, jotka kuuluvat FENNOA-reitille (kaikki paitsi Vakuutusyhtiö-
// maksajat, jotka menevät Innovoice/Finvoice-reittiä, ks. luoFinvoiceXml).
// PAKOTTAA uuden järjestelmän käyttöön: jos työllä ei ole yhtään sopivaa
// Laskuriviä, palautetaan virhe sen sijaan että käytettäisiin vanhaa
// laskeTyonKokonaishinta-mallia. Tämä on tarkoituksellista — ei haluta
// hiljaista taaksepäin-yhteensopivuutta joka sekoittaisi kumpaa
// laskentatapaa mikäkin lasku käytti.
// LASKURIVIT 16.9.2026 — hakee Laskurivit-taulusta kaikki rivit tälle
// työlle, jotka kuuluvat FENNOA-reitille (kaikki paitsi Vakuutusyhtiö-
// maksajat, jotka menevät Innovoice/Finvoice-reittiä, ks. luoFinvoiceXml).
//
// KORJAUS 16.9.2026: alkuperäinen versio käytti Airtable-kaavaa
// FIND(tyoId, ARRAYJOIN({Työtilaus})) hakuun, mutta ARRAYJOIN palauttaa
// linkkikentän NÄYTTÖNIMEN (esim. "STM-2026-V00166"), ei record ID:tä —
// haku ei siis koskaan löytänyt mitään vaikka data oli oikein (todistettu
// debugHaeFennoaLaskurivit-diagnostiikkafunktiolla). Korjattu hakemaan
// KAIKKI Laskurivit ja suodattamaan JavaScript-puolella suoraan
// Työtilaus-kentän record ID -listasta, mikä on luotettavampi tapa.
//
// PAKOTTAA uuden järjestelmän käyttöön: jos työllä ei ole yhtään sopivaa
// Laskuriviä, palautetaan virhe sen sijaan että käytettäisiin vanhaa
// laskeTyonKokonaishinta-mallia. Tämä on tarkoituksellista — ei haluta
// hiljaista taaksepäin-yhteensopivuutta joka sekoittaisi kumpaa
// laskentatapaa mikäkin lasku käytti.
// LASKURIVIT 16.9.2026 — hakee KAIKKI Laskurivit-taulun rivit yhdelle
// työlle riippumatta Maksajasta. Käytetään sekä koostaFennoaLaskuData:n
// että luoFinvoiceXml:n toimesta, jotka suodattavat tuloksesta oman
// reittinsä rivit (ks. haeFennoaLaskurivit).
//
// KORJAUS 16.9.2026: haetaan KAIKKI rivit ja suodatetaan record ID:n
// perusteella JavaScript-puolella — Airtable-kaava
// FIND(tyoId, ARRAYJOIN({Työtilaus})) EI toiminut, koska ARRAYJOIN
// palauttaa linkkikentän näyttönimen (esim. "STM-2026-V00166"), ei
// record ID:tä. Todistettu debugHaeFennoaLaskurivit-diagnostiikalla.
function haeKaikkiLaskurivitTyolle(tyoId) {
  const kaikki = airtableListAll('Laskurivit', 'TRUE()', 'Lisätty', 'asc');
  return kaikki.filter(r => (r.fields['Työtilaus'] || []).includes(tyoId));
}

function haeFennoaLaskurivit(tyoId) {
  return haeKaikkiLaskurivitTyolle(tyoId).filter(r => r.fields['Maksaja'] !== 'Vakuutusyhtiö');
}

// Koostaa Fennoan JSON-rungon yhden Työtilauksen Laskurivit-tauluun
// tallennetuista riveistä. EI vakuutustapauksia varten — asiakas maksaa
// itse (tai leasing-yhtiö/yritys/käteinen-kortti). Rakenne noudattaa
// Fennoan 28.8.2026 antamaa esimerkkiä tarkasti.
//
// JOKAINEN Laskurivi näkyy omana rivinään Fennoa-laskulla — ei enää
// jaeta yhtä kokonaissummaa tasan, koska jokaisella rivillä on jo oma
// tarkka Yksikköhinta (alv 0%). Tämä poistaa aiemman pyöristysongelman
// kokonaan (ei enää useaa erikseen pyöristettyä hintaa jotka eivät
// täsmää summana).
function koostaFennoaLaskuData(tyoRecord, asiakas) {
  const tf = tyoRecord.fields;
  const laskurivit = haeFennoaLaskurivit(tyoRecord.id);

  if (laskurivit.length === 0) {
    throw new Error('Työltä puuttuu laskurivit (Laskurivit-taulu) — ei voida muodostaa Fennoa-laskua.');
  }

  const rows = laskurivit.map(r => ({
    name: r.fields['Nimike'] || 'Rivi',
    description: '',
    quantity: r.fields['Määrä'] || 1,
    price: (parseFloat(r.fields['Yksikköhinta (alv 0%)']) || 0).toFixed(2),
    unit: 'kpl',
    vatpercent: String(r.fields['ALV %'] || 25.5)
  }));

  const invoiceDate = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');
  const dueDate = Utilities.formatDate(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), 'Europe/Helsinki', 'yyyy-MM-dd'
  );

  const onYritys = asiakas['asiakastyyppi'] && asiakas['asiakastyyppi'] !== 'Yksityinen';
  const nimi = onYritys
    ? (asiakas['yrityksen nimi'] || '')
    : [asiakas['etunimi'], asiakas['sukunimi']].filter(Boolean).join(' ');

  return {
    customer_no: '',  // tyhjä = Fennoa luo/tunnistaa; TÄRKEÄÄ: kun asiakas on
                       // kerran luotu Fennoaan, sen customer_no pitäisi
                       // tallentaa Airtableen ja käyttää jatkossa, jotta ei
                       // synny tuplakortteja (Fennoan oma huomautus 28.8.2026)
    name: nimi,
    address: asiakas['osoite'] || '',
    postalcode: asiakas['postinumero'] || '',
    city: asiakas['kaupunki'] || '',
    country: 'FI',
    vat_number: onYritys ? ('FI' + String(asiakas['y-tunnus'] || '').replace('-', '')) : '',
    account_type_id: onYritys ? 1 : 2,  // 1=yritys, 2=kuluttaja (Fennoan oma koodisto)
    invoice_date: invoiceDate,
    due_date: dueDate,
    delivery_method: 'email',
    einvoice_address: asiakas['sähköposti'] || '',
    locale: 'fi',
    order_identifier: tf['varausnumero'] || '',
    row: rows,
    laskuriviIdt: laskurivit.map(r => r.id),  // ei lähetetä Fennoalle, käytetään vain merkitsemään rivit laskutetuiksi lähetyksen jälkeen
    kaikkiKateinenKortti: laskurivit.every(r => r.fields['Maksaja'] === 'Käteinen/Kortti'),
  };
}

// Lähettää yhden ei-vakuutus-työn laskun Fennoaan JSON-muodossa.
// Palauttaa aina { ok: true/false, ... } -muotoisen olion.
function lahetaFennoaLasku(tyoId) {
  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
  if (!tyoRecord) {
    return { ok: false, vaihe: 'haku', error: 'Työtilausta ei löytynyt: ' + tyoId };
  }

  const asiakasIds = tyoRecord.fields['Asiakas'] || [];
  if (asiakasIds.length === 0) {
    return { ok: false, vaihe: 'haku', error: 'Työllä ei ole asiakasta linkitettynä.' };
  }
  const asiakasRecord = airtableGetById(TABLE_ASIAKKAAT, asiakasIds[0]);
  if (!asiakasRecord) {
    return { ok: false, vaihe: 'haku', error: 'Asiakastietuetta ei löytynyt.' };
  }

  let laskuData;
  try {
    laskuData = koostaFennoaLaskuData(tyoRecord, asiakasRecord.fields);
  } catch (kokoamisVirhe) {
    // LASKURIVIT 16.9.2026: koostaFennoaLaskuData heittää virheen jos
    // työltä puuttuu sopivat Laskurivit — tämä on tarkoituksellista
    // (pakottaa uuden järjestelmän käyttöön), napataan se tässä siistiksi
    // virhevastaukseksi kaatumatta koko funktiota.
    return { ok: false, vaihe: 'laskurivit', error: kokoamisVirhe.message };
  }

  try {
    const resp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/sales_api/add', {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'Authorization': fennoaAuthHeader() },
      payload: JSON.stringify(laskuData),
      muteHttpExceptions: true
    });

    const koodi = resp.getResponseCode();
    const teksti = resp.getContentText();
    Logger.log('Fennoa-lasku (' + tyoId + '), HTTP ' + koodi + ': ' + teksti.slice(0, 500));

    if (koodi < 200 || koodi >= 300) {
      return {
        ok: false,
        vaihe: 'fennoa_lahetys',
        httpKoodi: koodi,
        error: 'Fennoa vastasi HTTP ' + koodi + ': ' + teksti.slice(0, 300)
      };
    }

    let data = null;
    try {
      data = JSON.parse(teksti);
    } catch (parseErr) {
      data = null;
    }

    // LASKURIVIT 16.9.2026: kun lähetys onnistui, merkitään kaikki tähän
    // laskuun kuuluneet Laskurivit laskutetuiksi ja tallennetaan laskun
    // tunniste. Tämä estää samojen rivien laskuttamisen uudelleen ja
    // suojaa ne poistolta (ks. kasitteleLaskurivinPoisto).
    const laskuId = (data && data.id) ? String(data.id) : '';
    if (laskuData.laskuriviIdt && laskuData.laskuriviIdt.length > 0) {
      laskuData.laskuriviIdt.forEach(riviId => {
        try {
          airtablePatch('Laskurivit', riviId, { 'Laskutettu': true, 'Lasku-ID': laskuId });
        } catch (merkintaVirhe) {
          // Lasku on jo lähtenyt Fennoaan onnistuneesti — yksittäisen rivin
          // merkinnän epäonnistuminen ei saa näyttää koko lähetystä
          // epäonnistuneena, mutta se pitää kirjata, jotta rivi voidaan
          // tarvittaessa merkitä käsin laskutetuksi jälkikäteen.
          Logger.log('HUOM: Laskurivin ' + riviId + ' merkintä laskutetuksi epäonnistui (' + tyoId + '): ' + merkintaVirhe.message);
        }
      });
    }

    // KÄTEINEN/KORTTI 17.9.2026: jos KOKO tämän laskun rivit ovat
    // Käteinen/Kortti, raha on jo saatu kädessä/korttiautomaatilla —
    // merkitään lasku heti maksetuksi Fennoan maksu-API:lla. Jos laskulla
    // on sekaisin muitakin rivejä, EI merkitä maksetuksi (osa summasta ei
    // silloin oikeasti ole maksettu vielä).
    if (laskuData.kaikkiKateinenKortti && laskuId) {
      try {
        // VAIHE 1: uusi lasku on Fennoassa aluksi vain LUONNOS (draft) —
        // sillä ei ole vielä virallista invoice_no:ta, vain sisäinen id.
        // "do/approve" hyväksyy laskun ja varaa sille invoice_no:n.
        // (Todistettu 17.9.2026: maksumerkintä epäonnistui "Invoice X not
        // found" -virheellä kun invoice_no:na yritettiin käyttää suoraan
        // /add:n palauttamaa sisäistä id:tä.)
        const hyvaksyResp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/sales_api/do/approve/' + laskuId, {
          method: 'POST',
          headers: { 'Authorization': fennoaAuthHeader() },
          muteHttpExceptions: true
        });
        Logger.log('Laskun hyväksyntä (' + tyoId + '): HTTP ' + hyvaksyResp.getResponseCode() + ' ' + hyvaksyResp.getContentText().slice(0, 300));

        // VAIHE 2: haetaan hyväksytyn laskun tiedot, jotta saadaan oikea
        // invoice_no (eri asia kuin sisäinen id).
        const laskuTiedotResp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/sales_api/' + laskuId, {
          method: 'GET',
          headers: { 'Authorization': fennoaAuthHeader() },
          muteHttpExceptions: true
        });
        let invoiceNo = laskuId; // varasuunnitelma jos jäsennys epäonnistuu
        Logger.log('Laskutietojen haku (' + tyoId + '): HTTP ' + laskuTiedotResp.getResponseCode() + ' ' + laskuTiedotResp.getContentText().slice(0, 800));
        try {
          const laskuTiedot = JSON.parse(laskuTiedotResp.getContentText());
          // Fennoan vastausmuoto on {status:'ok', data:{SalesInvoice:{...}}}
          // — invoice_no on siis kaksi tasoa syvemmällä (todistettu 17.9.2026).
          const sv = laskuTiedot && (
            (laskuTiedot.data && laskuTiedot.data.SalesInvoice) ||
            laskuTiedot.SalesInvoice ||
            laskuTiedot.data
          );
          if (sv && sv.invoice_no) invoiceNo = sv.invoice_no;
        } catch (jsonErr) {
          Logger.log('HUOM: laskutietojen jäsennys epäonnistui (' + tyoId + '): ' + jsonErr.message);
        }
        Logger.log('Laskun invoice_no (' + tyoId + '): ' + invoiceNo + ' (sisäinen id: ' + laskuId + ')');

        // VAIHE 3: itse maksumerkintä oikealla invoice_no:lla.
        const summaYhteensa = Number(laskuData.row.reduce((s, r) =>
          s + (parseFloat(r.price) * r.quantity * (1 + parseFloat(r.vatpercent) / 100)), 0
        ).toFixed(2));
        const maksuResp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/sales_api/add/payment', {
          method: 'POST',
          contentType: 'application/json',
          headers: { 'Authorization': fennoaAuthHeader() },
          payload: JSON.stringify({
            invoice_no: String(invoiceNo),
            payment_date: Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd'),
            sum: summaYhteensa, // HUOM: oltava JSON-numero, ei merkkijono
            payment_type: 4, // kortti — Käteinen ja Kortti ovat tänään sama Maksaja-vaihtoehto
            is_factoring: 0,
            description: 'Maksettu asennuspisteessä'
          }),
          muteHttpExceptions: true
        });
        Logger.log('Maksumerkintä (' + tyoId + '): HTTP ' + maksuResp.getResponseCode() + ' ' + maksuResp.getContentText().slice(0, 300));
      } catch (maksuErr) {
        Logger.log('HUOM: maksumerkintä epäonnistui (' + tyoId + '): ' + maksuErr.message);
      }
    }

    return { ok: true, vaihe: 'fennoa_lahetys', vastaus: data, lahetettyData: laskuData };

  } catch (err) {
    Logger.log('Fennoa-lähetys epäonnistui (' + tyoId + '): ' + err.message);
    return { ok: false, vaihe: 'verkko', error: err.message };
  }
}

// VAKUUTUSYHTIÖN FENNOA-LUONNOS 18.9.2026 (Carlin pyynnöstä): sama
// tekniikka kuin koostaFennoaLaskuData/lahetaFennoaLasku, mutta
// vastaanottajana on Vakuutusyhtiö-tietue (esim. "If") eikä asiakas, ja
// riveinä käytetään VAIN Maksaja=Vakuutusyhtiö-rivejä (Lasi/Työ/Tarvikkeet/
// Kalibrointi + Omavastuu-vähennys). JÄÄ TARKOITUKSELLA LUONNOKSEKSI —
// EI hyväksytä (do/approve) eikä lähetetä mitenkään automaattisesti,
// täsmälleen kuten tavallinen asiakaslaskukin jää luonnokseksi tänään.
// Carl käy itse hyväksymässä/käsittelemässä sen Fennoassa kun haluaa.
// KORJAUS 18.9.2026: Fennoa vastasi HTTP 400:llä ensimmäisellä yrityksellä
// (STM-2026-V00185) — postalcode ja city eivät saa olla tyhjiä, ja
// delivery_method:'email' vaatii kelvollisen sähköpostin (meillä ei ole
// vakuutusyhtiölle sähköpostia, vain Vakuutusyhtiöt-taulun 'laskutusosoite'-
// tekstikenttä, esim. "..., PL 2025, 20025 IF"). Puretaan postinumero+
// kaupunki tuon tekstin lopusta, ja käytetään verkkolaskuosoitetta
// (Vakuutusyhtiöt-taulun 'verkkolasku'-kenttä, esim. Ifillä oikea Tietoevry-
// operaattoriosoite) delivery_method:'einvoice'-arvon kanssa sähköpostin
// sijaan kun se on tiedossa. Jos yhtiöltä puuttuu nämä tiedot kokonaan
// (esim. Turva/LähiTapiola/Pohjola tänään), Fennoa palauttaa taas 400:n —
// silloin tiedot pitää ensin täyttää Vakuutusyhtiöt-tauluun.
function jaaOsoitePostinumeroKaupunki(osoiteTeksti) {
  const teksti = String(osoiteTeksti || '').trim();
  const osuma = teksti.match(/(\d{5})\s+([^,]+)\s*$/);
  if (osuma) {
    return {
      katuosoite: teksti.slice(0, osuma.index).replace(/[,\s]+$/, ''),
      postinumero: osuma[1],
      kaupunki: osuma[2].trim()
    };
  }
  return { katuosoite: teksti, postinumero: '', kaupunki: '' };
}

function koostaVakuutusFennoaLaskuData(tyoRecord, vakuutusyhtioFields) {
  const tf = tyoRecord.fields;
  const vakuutusRivit = haeKaikkiLaskurivitTyolle(tyoRecord.id)
    .filter(r => r.fields['Maksaja'] === 'Vakuutusyhtiö');

  if (vakuutusRivit.length === 0) {
    throw new Error('Työltä puuttuu Vakuutusyhtiö-maksajan Laskurivit — ei voida muodostaa vakuutusyhtiön Fennoa-luonnosta.');
  }

  const rows = vakuutusRivit.map(r => ({
    name: r.fields['Nimike'] || 'Rivi',
    description: '',
    quantity: r.fields['Määrä'] || 1,
    price: (parseFloat(r.fields['Yksikköhinta (alv 0%)']) || 0).toFixed(2),
    unit: 'kpl',
    vatpercent: String(r.fields['ALV %'] || 25.5)
  }));

  const invoiceDate = Utilities.formatDate(new Date(), 'Europe/Helsinki', 'yyyy-MM-dd');
  const dueDate = Utilities.formatDate(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), 'Europe/Helsinki', 'yyyy-MM-dd'
  );

  const yTunnus = String(vakuutusyhtioFields['Y-tunnus'] || '').trim();
  const osoiteOsat = jaaOsoitePostinumeroKaupunki(vakuutusyhtioFields['laskutusosoite']);

  if (!osoiteOsat.postinumero || !osoiteOsat.kaupunki) {
    throw new Error('Vakuutusyhtiöltä (' + (vakuutusyhtioFields['yhtiön nimi'] || '?') +
      ') puuttuu postinumero/kaupunki laskutusosoitteesta — täytä Vakuutusyhtiöt-taulun laskutusosoite-kenttä kokonaisena osoitteena (esim. "..., 20025 IF"), tai lisää tiedot Airtableen ennen kuin tämä toimii tälle yhtiölle.');
  }

  const laskuData = {
    customer_no: '',
    name: vakuutusyhtioFields['yhtiön nimi'] || '',
    address: osoiteOsat.katuosoite,
    postalcode: osoiteOsat.postinumero,
    city: osoiteOsat.kaupunki,
    country: 'FI',
    vat_number: yTunnus ? ('FI' + yTunnus.replace('-', '')) : '',
    account_type_id: 1, // yritys
    invoice_date: invoiceDate,
    due_date: dueDate,
    locale: 'fi',
    order_identifier: tf['varausnumero'] || '',
    row: rows,
    laskuriviIdt: vakuutusRivit.map(r => r.id),
    // KORJAUS 19.9.2026: Carl vahvisti (STM-2026-V00185-testin jälkeen), että
    // lähetystavaksi halutaan nimenomaan "Lähetetään käsin" — Fennoan
    // dokumentaation mukaan tämä on API-arvoltaan 'manual' ("invoice is not
    // sent but possible delivery error message is cleared"). Aiempi yritys
    // ('einvoice') EI ole Fennoan API:n tunnistama arvo, minkä vuoksi lasku
    // päätyi luonnoksena tilille asetettuun oletukseen ("Postitse") sen
    // sijaan että lähetystapa olisi asettunut oikein. 'manual' toimii aina,
    // eikä vaadi verkkolasku-/sähköpostiosoitetta — sopii hyvin myös
    // yhtiöille, joilta 'verkkolasku'-kenttä puuttuu.
    delivery_method: 'manual',
  };

  return laskuData;
}

function luoVakuutusFennoaLasku(tyoId) {
  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
  if (!tyoRecord) {
    return { ok: false, vaihe: 'haku', error: 'Työtilausta ei löytynyt: ' + tyoId };
  }

  const vakuutusRivi = haeVakuutustapausTyolle(tyoId);
  if (!vakuutusRivi) {
    return { ok: false, vaihe: 'haku', error: 'Työllä ei ole vakuutustapausta.' };
  }
  const vyIds = vakuutusRivi.fields['Vakuutusyhtiö'] || [];
  if (vyIds.length === 0) {
    return { ok: false, vaihe: 'haku', error: 'Vakuutustapaukselta puuttuu Vakuutusyhtiö-linkki.' };
  }
  const vyRecord = airtableGetById(TABLE_VAKUUTUSYHTIOT, vyIds[0]);
  if (!vyRecord) {
    return { ok: false, vaihe: 'haku', error: 'Vakuutusyhtiön tietuetta ei löytynyt.' };
  }

  let laskuData;
  try {
    laskuData = koostaVakuutusFennoaLaskuData(tyoRecord, vyRecord.fields);
  } catch (kokoamisVirhe) {
    return { ok: false, vaihe: 'laskurivit', error: kokoamisVirhe.message };
  }

  try {
    const resp = UrlFetchApp.fetch(FENNOA_BASE_URL + '/sales_api/add', {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'Authorization': fennoaAuthHeader() },
      payload: JSON.stringify(laskuData),
      muteHttpExceptions: true
    });

    const koodi = resp.getResponseCode();
    const teksti = resp.getContentText();
    Logger.log('Vakuutusyhtiön Fennoa-luonnos (' + tyoId + '), HTTP ' + koodi + ': ' + teksti.slice(0, 500));

    if (koodi < 200 || koodi >= 300) {
      return {
        ok: false,
        vaihe: 'fennoa_lahetys',
        httpKoodi: koodi,
        error: 'Fennoa vastasi HTTP ' + koodi + ': ' + teksti.slice(0, 300)
      };
    }

    let data = null;
    try {
      data = JSON.parse(teksti);
    } catch (parseErr) {
      data = null;
    }

    const laskuId = (data && data.id) ? String(data.id) : '';
    if (laskuData.laskuriviIdt && laskuData.laskuriviIdt.length > 0) {
      laskuData.laskuriviIdt.forEach(riviId => {
        try {
          airtablePatch('Laskurivit', riviId, { 'Laskutettu': true, 'Lasku-ID': laskuId });
        } catch (merkintaVirhe) {
          Logger.log('HUOM: Vakuutusrivin ' + riviId + ' merkintä laskutetuksi epäonnistui (' + tyoId + '): ' + merkintaVirhe.message);
        }
      });
    }

    return { ok: true, vaihe: 'fennoa_lahetys', vastaus: data, lahetettyData: laskuData };

  } catch (err) {
    Logger.log('Vakuutusyhtiön Fennoa-luonnoksen lähetys epäonnistui (' + tyoId + '): ' + err.message);
    return { ok: false, vaihe: 'verkko', error: err.message };
  }
}

// TESTIFUNKTIO laskun lähetykselle — käytä TESTIYMPÄRISTÖN tunnuksilla
// ja jollain ei-kriittisellä testityöllä. ÄLÄ aja tuotantotunnuksilla
// ennen kuin testiympäristössä on nähty onnistunut lasku Fennoan puolella.
function testaaFennoaLahetys() {
  const tyoRivi = airtableGet(TABLE_TYOTILAUKSET, `{varausnumero}="STM-2026-V00174"`);
  if (!tyoRivi) {
    Logger.log('Ei löytynyt testityötä STM-2026-V00174. Anna toinen varausnumero.');
    return 'Ei testidataa saatavilla.';
  }

  const tulos = lahetaFennoaLasku(tyoRivi.id);
  Logger.log(JSON.stringify(tulos, null, 2));
  return JSON.stringify(tulos, null, 2);
}

function testaaFinvoiceXml() {
  const tyoRivi = airtableGet(
    TABLE_TYOTILAUKSET,
    `{varausnumero}="STM-2026-V00116"`
  );
  if (!tyoRivi) {
    Logger.log('Ei löytynyt työtä STM-2026-V00116. Tarkista varausnumero Airtablesta.');
    return 'Ei testidataa saatavilla.';
  }

  const tulos = luoFinvoiceXml(tyoRivi.id);
  if (!tulos.ok) {
    Logger.log('VIRHE: ' + tulos.error);
    return 'VIRHE: ' + tulos.error;
  }

  Logger.log(tulos.xml);
  return tulos.xml;
}

// LASKURIVIT 16.9.2026 — lisäys ja poisto. Maksaja tarkistetaan aina
// sallittujen vaihtoehtojen listasta (ei koskaan vapaa teksti), koska
// Airtable-kentän arvon täytyy täsmätä sen singleSelect-vaihtoehtoihin.
function kasitteleLaskurivinLisays(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }

    const tyoId = String(body.tyoId || '');
    if (!RECORD_ID_MUOTO.test(tyoId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen työn tunniste.' });
    }

    const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoId);
    if (!tyoRecord) {
      return jsonVastaus({ ok: false, error: 'Työtä ei löydy.' });
    }

    // Sama oikeustarkistus kuin muissakin työhön liittyvissä toiminnoissa —
    // asentaja/varauskeskus saa lisätä rivin vain oman pisteensä työlle.
    const pisteet = haeSallitutPisteetLopullinen(email);
    const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
    if (pisteet === null || !pisteet.includes(tyoPiste)) {
      return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
    }

    const nimike = String(body.nimike || '').trim();
    if (!nimike) {
      return jsonVastaus({ ok: false, error: 'Nimike puuttuu.' });
    }

    const SALLITUT_MAKSAJAT = ['Asiakas', 'Vakuutusyhtiö', 'Leasing-yhtiö', 'Työnantaja', 'Käteinen/Kortti'];
    const maksaja = String(body.maksaja || '').trim();
    if (!SALLITUT_MAKSAJAT.includes(maksaja)) {
      return jsonVastaus({ ok: false, error: 'Maksaja puuttuu tai on virheellinen. Sallitut: ' + SALLITUT_MAKSAJAT.join(', ') });
    }

    const SALLITUT_LAHTEET = ['Varaus', 'Asentaja lisäsi', 'Manuaalinen'];
    const lahde = SALLITUT_LAHTEET.includes(body.lahde) ? body.lahde : 'Manuaalinen';

    const maara = numeroTaiNull(body.maara) || 1;
    const yksikkohinta = numeroTaiNull(body.yksikkohinta) || 0;
    const alvProsentti = numeroTaiNull(body.alvProsentti) || 25.5;

    // DUPLIKAATTIESTO 22.9.2026: Carl raportoi että sama rivi ("Testi")
    // syntyi kahdesti kun asentaja.html:n Tarvikkeet/lisämyynti-ikkuna
    // suljettiin ja avattiin uudelleen ilman että "+ Lisää" -nappia
    // painettiin uudestaan (todennäköisesti kaksoisnapautus kosketus-
    // näytöllä tai hidas verkko sai lähetyksen menemään kahdesti). Sama
    // periaate kuin varauksen duplikaattiestossa (suoritaVarauksenTallennus)
    // ja merkitseValmiiksi-lukossa: jos TÄSMÄLLEEN sama rivi (sama työ,
    // nimike, hinta, maksaja, lähde) on lisätty viimeisen 30 sekunnin
    // sisällä, palautetaan se olemassa oleva rivi uuden luonnin sijaan.
    try {
      const olemassaOlevatRivit = haeKaikkiLaskurivitTyolle(tyoId);
      const kolmekymmentaSekuntiaSitten = Date.now() - 30 * 1000;
      const duplikaatti = olemassaOlevatRivit.find(r => {
        const f = r.fields;
        if ((f['Nimike'] || '') !== nimike) return false;
        if ((f['Maksaja'] || '') !== maksaja) return false;
        if ((f['Lähde'] || '') !== lahde) return false;
        if (Math.abs((parseFloat(f['Yksikköhinta (alv 0%)']) || 0) - yksikkohinta) > 0.001) return false;
        const lisattyAika = new Date(f['Lisätty'] || 0).getTime();
        return lisattyAika >= kolmekymmentaSekuntiaSitten;
      });
      if (duplikaatti) {
        Logger.log('DUPLIKAATTI ESTETTY (Laskurivi): ' + nimike + ' / ' + tyoId + ' — palautetaan olemassa oleva ' + duplikaatti.id);
        return jsonVastaus({ ok: true, id: duplikaatti.id, duplikaattiEstetty: true });
      }
    } catch (dupErr) {
      // Duplikaattitarkistuksen epäonnistuminen ei saa estää oikean rivin
      // lisäystä — parempi mahdollinen harvinainen duplikaatti kuin ettei
      // rivi tallennu ollenkaan.
      Logger.log('Laskurivin duplikaattitarkistus epäonnistui (ei kriittistä, jatketaan): ' + dupErr.message);
    }

    const kentat = {
      'Nimike': nimike,
      'Työtilaus': [tyoId],
      'Määrä': maara,
      'Yksikköhinta (alv 0%)': yksikkohinta,
      'ALV %': alvProsentti,
      'Maksaja': maksaja,
      'Lisääjä': email,
      'Lähde': lahde,
      'Laskutettu': false,
    };

    const luotu = airtablePost('Laskurivit', kentat);
    lisaaMuokkausHistoriaan(tyoId, email, 'Lisäsi laskurivin: ' + nimike + ' (' + maksaja + ')');

    return jsonVastaus({ ok: true, id: luotu.id });

  } catch (err) {
    Logger.log('Laskurivin lisäys epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

function kasitteleLaskurivinPoisto(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const email = haeKirjautuneenSahkoposti(body.token || '');
    if (!email) {
      return jsonVastaus({ ok: false, error: 'Kirjautuminen puuttuu tai on vanhentunut. Kirjaudu uudelleen.' });
    }

    const riviId = String(body.riviId || '');
    if (!RECORD_ID_MUOTO.test(riviId)) {
      return jsonVastaus({ ok: false, error: 'Virheellinen rivin tunniste.' });
    }

    const rivi = airtableGetById('Laskurivit', riviId);
    if (!rivi) {
      return jsonVastaus({ ok: false, error: 'Riviä ei löydy (ehkä jo poistettu).' });
    }

    // Turvallisuusesto: jo laskutettua riviä ei saa poistaa, koska se on
    // jo mennyt Fennoalle/Innovoiceen — poisto vain vääristäisi kirjanpitoa
    // täsmäämättä enää lähetetyn laskun kanssa.
    if (rivi.fields['Laskutettu'] === true) {
      return jsonVastaus({ ok: false, error: 'Riviä ei voi poistaa — se on jo laskutettu (Lasku-ID: ' + (rivi.fields['Lasku-ID'] || '?') + ').' });
    }

    const tyoLinkit = rivi.fields['Työtilaus'] || [];
    if (tyoLinkit.length > 0) {
      const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, tyoLinkit[0]);
      if (tyoRecord) {
        const pisteet = haeSallitutPisteetLopullinen(email);
        const tyoPiste = tyoRecord.fields['asennuspiste/location'] || '';
        if (pisteet === null || !pisteet.includes(tyoPiste)) {
          return jsonVastaus({ ok: false, error: 'Ei oikeutta tähän asennuspisteeseen (' + tyoPiste + ')' });
        }
        lisaaMuokkausHistoriaan(tyoLinkit[0], email, 'Poisti laskurivin: ' + (rivi.fields['Nimike'] || ''));
      }
    }

    airtableDelete('Laskurivit', riviId);
    return jsonVastaus({ ok: true });

  } catch (err) {
    Logger.log('Laskurivin poisto epäonnistui: ' + err.message);
    return jsonVastaus({ ok: false, error: err.message });
  }
}

// TESTIFUNKTIO 16.9.2026 — aja tämä Apps Script -editorissa manuaalisesti
// (▶-nappi) testataksesi lisaaLaskurivi-toimintoa. Muuta testiTyoId
// johonkin oikeaan, olemassa olevaan työtilaukseen ennen ajoa.
function testaaLaskurivinLisays() {
  const testiTyoId = 'recOBMlK7op4hgCJA'; // STM-2026-V00166, tunnettu testityö
  const omaEmail = Session.getActiveUser().getEmail() || 'testi@stm.fi';

  const simuloituPyynto = {
    postData: {
      contents: JSON.stringify({
        token: '', // tyhjä = haeKirjautuneenSahkoposti palaa nullina normaalisti,
                   // mutta koska ajamme tätä suoraan editorissa Apps Scriptin
                   // omalla identiteetillä, ohitetaan token-tarkistus testiä varten
                   // korvaamalla email suoraan alla.
        tyoId: testiTyoId,
        nimike: 'Testirivi (poista tämä)',
        maara: 1,
        yksikkohinta: 100,
        alvProsentti: 25.5,
        maksaja: 'Asiakas',
        lahde: 'Manuaalinen',
      })
    }
  };

  // Testiä varten ohitetaan kirjautumistarkistus kutsumalla suoraan
  // sisäistä logiikkaa emailin kanssa, koska token-pohjainen kirjautuminen
  // ei toimi Apps Script -editorin "Suorita"-napista käsin.
  const body = JSON.parse(simuloituPyynto.postData.contents);
  const tyoRecord = airtableGetById(TABLE_TYOTILAUKSET, body.tyoId);
  if (!tyoRecord) {
    Logger.log('VIRHE: Testityötä ei löytynyt: ' + body.tyoId);
    return 'VIRHE: Testityötä ei löytynyt.';
  }

  const kentat = {
    'Nimike': body.nimike,
    'Työtilaus': [body.tyoId],
    'Määrä': body.maara,
    'Yksikköhinta (alv 0%)': body.yksikkohinta,
    'ALV %': body.alvProsentti,
    'Maksaja': body.maksaja,
    'Lisääjä': omaEmail,
    'Lähde': body.lahde,
    'Laskutettu': false,
  };

  const luotu = airtablePost('Laskurivit', kentat);
  Logger.log('Laskurivi luotu onnistuneesti: ' + luotu.id);
  return 'OK: ' + luotu.id;
}
