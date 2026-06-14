# Secure Event Ticketing Platform

Aplikacija za prodaju karata složena od više servisa, isporučena kroz cijeli DevOps / DevSecOps proces: lokalni razvoj preko Docker Compose-a, CI/CD s skeniranjem slika, i postavljanje na Kubernetes.

## Servisi

| Servis | Tehnologija | Port | Uloga |
|--------|-------------|------|-------|
| frontend | Node.js / Express | 3000 | Web sučelje + `/config` endpoint |
| api | Node.js / Express | 8080 | REST API: eventi, narudžbe, health/readiness |
| worker | Node.js | – | Uzima narudžbe iz reda i zapisuje ih u bazu |
| postgres | PostgreSQL 16 | 5432 | Trajna pohrana narudžbi |
| redis | Redis 7 | 6379 | Red (queue) / cache |

**Tok:** preglednik → frontend → (config) → preglednik → api → Redis (red) → worker → Postgres.

## Dokumentacija

- `docs/architecture.md` — analiza arhitekture (kontejneri vs VM, uloge servisa, komunikacija).
- `docs/security/image-scan-report.md` — rezultati Trivy skeniranja i popravci.
- `docs/runbook.md` — runbook za rješavanje problema.

---

## 1. dio — Lokalni razvoj (Docker Compose)

### Što treba imati
- Docker Desktop (na Windowsu s WSL2)
- Git

### Pokretanje
```bash
# iz korijena repozitorija
cp .env.example .env          # napravi lokalni .env (ne commitaj ga)
docker compose up --build     # pokreće svih pet servisa
```

Stack kreće redom: prvo postgres i redis (dok ne budu zdravi), pa onda api/worker/frontend. Izvorni kod je mountan pa radi hot-reload za razvoj.

### Provjera da radi
```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl http://localhost:8080/events
curl -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
curl http://localhost:8080/tickets/orders
```
Ako narudžba u `/tickets/orders` ima `"status":"processed"`, znači da je prošla cijeli lanac: api → Redis → worker → Postgres. Sučelje je na **http://localhost:3000**.

### Gašenje
```bash
docker compose down       # ugasi, zadrži podatke baze
docker compose down -v    # ugasi i obriši podatke baze
```

---

## CI/CD (GitHub Actions)

Na svaki push/PR pipeline (`.github/workflows/ci.yml`) za svaki servis radi ovo:

1. instalira pakete (`npm ci`) i pokrene testove (`npm test`),
2. izgradi kontejnersku sliku,
3. **skenira sliku Trivyjem** i sruši build ako ima HIGH/CRITICAL ranjivosti za koje postoji popravak (quality gate),
4. na `main` grani, ako skeniranje prođe, objavi sliku na GitHub Container Registry s tagom commit SHA i `latest`.

Slike: `ghcr.io/mmaric76/ticketing-{api,worker,frontend}`.

---

## 2. dio — Produkcija (Kubernetes)

### Što treba imati
- Kubernetes klaster (ovdje minikube)
- `kubectl`
- Tri slike objavljene na ghcr.io i postavljene na **public** (ili napravljen pull secret)

### Postavljanje
```bash
minikube start --driver=docker
minikube addons enable ingress

kubectl apply -f k8s/
kubectl get pods -n ticketing -w     # čekaj da svi podovi budu Running / Ready
```

Ovime se naprave: namespace, ConfigMap + Secret, ServiceAccount + Role/RoleBinding, Postgres (Deployment + PVC) s init shemom, Redis, Deploymenti za api/worker/frontend s liveness/readiness probama i resource limitima, Servisi, Ingress i NetworkPolicy.

### Pristup aplikaciji

Na minikube **docker driveru** IP klastera se ne može doseći direktno s računala, pa se do aplikacije dolazi preko localhost tunela:

```bash
# izloži ingress controller na localhostu
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80
# dodaj "127.0.0.1 ticketing.local" u hosts datoteku, pa:
```
Otvori **http://ticketing.local:18080**, ili testiraj API direktno:
```bash
curl http://ticketing.local:18080/api/healthz
curl http://ticketing.local:18080/api/events
curl -X POST http://ticketing.local:18080/api/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
curl http://ticketing.local:18080/api/tickets/orders
```

### Rolling update i rollback
```bash
kubectl rollout restart deployment/api -n ticketing   # pokreni rolling update
kubectl rollout status  deployment/api -n ticketing
kubectl rollout history deployment/api -n ticketing
kubectl rollout undo    deployment/api -n ticketing    # vrati na prethodnu verziju
kubectl rollout status  deployment/api -n ticketing
```

### Sigurnosne kontrole u klasteru
- ConfigMap/Secret odvojeno, nema lozinki u kodu ni u slikama.
- Kontejneri ne rade kao root, maknute capabilities, nema privilege escalationa.
- Vlastiti ServiceAccount (token automount isključen) + minimalni RBAC.
- NetworkPolicy: do Postgresa i Redisa smiju samo api i worker.
- Trivy skeniranje u CI-ju prije nego se ijedna slika objavi.

---

## Rješavanje problema

Vidi `docs/runbook.md` za dijagnozu i popravak čestih problema (greške kod povlačenja slika, crash loop, pad baze, pristup kroz ingress na docker driveru, itd.).
