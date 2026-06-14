# Sigurnosno izvješće skeniranja slika

**Alat:** Trivy v0.71.0
**Datum:** 14.06.2026.
**Politika (quality gate):** build pada ako postoji HIGH ili CRITICAL ranjivost za koju postoji popravak (`--severity HIGH,CRITICAL --ignore-unfixed`, u CI-ju `exit-code: 1`).
**Bazna slika:** `node:20-alpine` (Alpine 3.23)

## Što je skenirano

Skenirane su tri slike aplikacije: `ticketing-api`, `ticketing-worker` i `ticketing-frontend`. Skeniranje se pokreće automatski u CI/CD pipelineu (`.github/workflows/ci.yml`) na svaki push. Slika se objavljuje na registar (ghcr.io) tek nakon što skeniranje prođe, pa ranjiva slika ne može završiti u registru.

## Rezultat nakon popravaka

| Slika | Critical | High | Status |
|-------|----------|------|--------|
| ticketing-api | 0 | 0 | PROŠLO |
| ticketing-worker | 0 | 0 | PROŠLO |
| ticketing-frontend | 0 | 0 | PROŠLO |

Sve tri slike sad prolaze quality gate bez HIGH i CRITICAL ranjivosti.

## Nađene ranjivosti i kako sam ih riješio

Prvo skeniranje je palo jer je Trivy našao HIGH ranjivosti. Riješio sam ih u dva koraka.

### 1. Ranjivosti u paketu tar (HIGH)

| CVE | Paket | Težina | Popravljeno u verziji |
|-----|-------|--------|------------------------|
| CVE-2026-24842 | tar | HIGH | 7.5.x |
| CVE-2026-26960 | tar | HIGH | 7.5.8 |
| CVE-2026-29786 | tar | HIGH | 7.5.10 |
| CVE-2026-31802 | tar | HIGH | 7.5.11 |

**Izvor:** ranjivosti su u paketu `tar` koji dolazi unutar npm-a, a npm je dio bazne slike `node:20-alpine`. Nisu dio ovisnosti same aplikacije (aplikacija koristi samo express, pg, redis, uuid, dotenv).

**Rješenje:** runtime kontejneri pokreću samo `node src/server.js` i nikad ne koriste npm. Zato sam maknuo npm iz runtime slike (`rm -rf /usr/local/lib/node_modules/npm ...`). Time su nestale ranjivosti, a slika je usput manja i ima manju površinu za napad.

### 2. Ranjivost u OpenSSL-u (HIGH)

| CVE | Paketi | Težina | Imao | Popravljeno |
|-----|--------|--------|------|-------------|
| CVE-2026-45447 | libcrypto3, libssl3 | HIGH | 3.5.6-r0 | 3.5.7-r0 |

**Izvor:** OpenSSL ranjivost (use-after-free u `PKCS7_verify()`) u OS paketima bazne slike.

**Rješenje:** u runtime fazi sam dodao `apk -U upgrade` koji pri gradnji slike povuče zakrpani OpenSSL (3.5.7-r0) i ostale popravke OS paketa, te očisti cache.

## Mjere za sigurnije slike (hardening)

- multi-stage build (alati za gradnju ne ulaze u finalnu sliku),
- minimalna bazna slika (alpine),
- pokretanje kao non-root korisnik (`node`, UID 1000),
- samo produkcijske ovisnosti (`npm ci --omit=dev`),
- maknut npm iz runtime slike,
- zakrpani OS paketi (`apk -U upgrade`).

## Politika označavanja i objave slika

- Svaka slika se označava nepromjenjivim commit SHA-om (`ghcr.io/mmaric76/ticketing-<servis>:<sha>`) plus pomični tag `latest`.
- Slike se objavljuju na ghcr.io samo s `main` grane i tek nakon što Trivy skeniranje prođe. Pad skeniranja zaustavlja objavu.

## Napomena

Politika je stroga, pa novootkrivena ranjivost može srušiti build koji je prije bio zelen, čak i bez promjene koda. Zato skeniranje radi na svakom buildu, a ne samo jednom. Ako za neku ranjivost u trenutku predaje ne postoji popravak, može se privremeno zabilježiti u `.trivyignore` uz obrazloženje i datum revizije.
