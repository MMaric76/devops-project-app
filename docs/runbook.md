# Runbook za rješavanje problema — Secure Event Ticketing Platform

Ovaj runbook pokriva dijagnozu i popravak najčešćih problema na Kubernetesu (namespace `ticketing`) i u CI/CD-u. Svaki slučaj ide istim redom: **simptom → dijagnoza → uzrok → popravak → provjera**.

Svi slučajevi su pravi problemi na koje sam naišao dok sam radio projekt. Naredbe i poruke su one koje sam stvarno koristio.

---

## 0. Prva provjera (kreni odavdje za bilo koji problem)

```bash
# Što ne radi?
kubectl get pods -n ticketing

# Zašto neki pod ne radi? (najvažniji su Eventi na dnu)
kubectl describe pod <ime-poda> -n ticketing | tail -25

# Što aplikacija loga?
kubectl logs deploy/<api|worker|frontend|postgres|redis> -n ticketing --tail=30
# dodaj --previous za logove iz pod koji je pao:
kubectl logs <ime-poda> -n ticketing --previous

# Zadnji eventi u namespaceu, najnoviji zadnji:
kubectl get events -n ticketing --sort-by=.lastTimestamp | tail -25
```

Health endpointi API-ja:
- `GET /healthz` — liveness, vrati 200 ako proces radi.
- `GET /readyz` — readiness, vrati 200 samo ako rade **i** Postgres **i** Redis. 503 znači da je neki od njih pao.

---

## Problem 1: Podovi se ne stvaraju — `FailedCreate ... serviceaccount not found`

**Simptom:** Deployment pokazuje `READY 0/1`, a `kubectl get pods -l app=<svc>` ne pokazuje nijedan pod (ni Pending).

**Dijagnoza:**
```bash
kubectl describe rs -n ticketing -l app=<svc> | tail -20
```
Eventi pokazuju:
```
Error creating: pods "..." is forbidden: error looking up service account
ticketing/ticketing-sa: serviceaccount "ticketing-sa" not found
```

**Uzrok:** Svaki Deployment koristi `serviceAccountName: ticketing-sa`. Ako RBAC manifest (`03-rbac.yaml`) koji definira taj ServiceAccount nije primijenjen (ili je primijenjen poslije Deploymenta), Kubernetes ne da napraviti podove.

**Popravak:**
```bash
kubectl apply -f k8s/03-rbac.yaml          # napravi ServiceAccount
kubectl rollout restart deployment/<svc> -n ticketing   # ponovi stvaranje poda
```

**Provjera:** `kubectl get pods -n ticketing` sad pokazuje pod kroz `ContainerCreating → Running`.

**Sprječavanje:** primijeni cijeli `k8s/` folder odjednom (`kubectl apply -f k8s/`) i nikad ne preskači RBAC datoteku.

---

## Problem 2: Worker u `CrashLoopBackOff` — ne može do baze

**Simptom:** `worker` pod se vrti `Running → Error → CrashLoopBackOff` i broj restarta raste, dok su `redis` i `frontend` zdravi.

**Dijagnoza:**
```bash
kubectl logs deploy/worker -n ticketing --tail=20
```
```
Worker fatal error: Error: connect ECONNREFUSED 10.x.x.x:5432
  code: 'ECONNREFUSED', address: '10.x.x.x', port: 5432
```

**Uzrok:** Worker na pokretanju radi `SELECT 1` na Postgres. Ako Postgres još nije `Running`/`Ready`, veza je odbijena i worker padne, a Kubernetes ga restarta, pa se vrti u krug. (U mom slučaju Postgres nije ni postojao zbog Problema 1.)

**Popravak:** Prvo digni Postgres, pa pusti worker da se oporavi.
```bash
kubectl get pods -n ticketing -l app=postgres     # provjeri status Postgresa
# kad je Postgres Running 1/1:
kubectl rollout restart deployment/worker -n ticketing   # natjeraj ponovni pokušaj
```

**Provjera:** Novi worker pod dođe do `Running 1/1` s `0` restarta. U logovima piše `Worker started and waiting for jobs...`.

**Napomena:** Par restarta workera dok se Postgres diže je normalno, worker se sam oporavi kad baza bude spremna. Brini se samo ako se nikad ne smiri.

---

## Problem 3: `ImagePullBackOff` / `ErrImagePull`

**Simptom:** `api`, `worker` ili `frontend` podovi ostaju `0/1` sa statusom `ImagePullBackOff`.

**Dijagnoza:**
```bash
kubectl describe pod <ime-poda> -n ticketing | tail -20
```
Pogledaj ime slike u Eventima. Dva česta uzroka:

1. **Krivo ime slike** — ostao placeholder (`ghcr.io/YOUR_GH_USERNAME/...`) ili velika slova (imena slika moraju biti mala slova; `MMaric76` ne valja, mora `mmaric76`).
2. **Privatni paket** — slika postoji na ghcr.io, ali je paket privatan i klaster nema pull secret.

**Popravak:**
- Za krivo ime, popravi u manifestima i ponovo primijeni:
  ```bash
  grep -rn "image:" k8s/                 # provjeri da svih 5 image linija valja
  kubectl apply -f k8s/
  ```
- Za privatni paket, ili stavi paket na **Public** (GitHub → Packages → paket → visibility), ili napravi pull secret:
  ```bash
  kubectl create secret docker-registry ghcr-cred -n ticketing \
    --docker-server=ghcr.io --docker-username=<user> --docker-password=<token>
  # pa dodaj imagePullSecrets: [{ name: ghcr-cred }] u pod spec
  ```

**Provjera:** `kubectl get pods -n ticketing` pokazuje da je slika povučena i pod `Running`.

---

## Problem 4: CI pipeline padne na Trivy skeniranju (quality gate)

**Simptom:** GitHub Actions job uspješno izgradi sliku, ali padne na koraku **Trivy scan** s `exit code 1`, i slika se **ne** objavi.

**Dijagnoza:** Otvori pali job → korak "Trivy scan". Tablica ranjivosti pokazuje HIGH/CRITICAL CVE-e s `Fixed Version`.

**Uzrok:** To je quality gate koji radi kako treba. Postavljen je da sruši build na HIGH/CRITICAL ranjivostima za koje postoji popravak, da ranjiva slika ne ode u registar.

**Popravak (riješi, ne preskači):**
- CVE-i u `tar` unutar npm-a → npm ne treba u runtimeu, pa ga maknem iz runtime slike (`rm -rf /usr/local/lib/node_modules/npm ...`).
- CVE-i u OS paketima (npr. OpenSSL `libcrypto3`/`libssl3`) → zakrpaj pri gradnji (`apk -U upgrade`).
- Skeniraj lokalno prije pusha:
  ```bash
  docker build -t test-<svc> ./<svc>
  trivy image --severity HIGH,CRITICAL --ignore-unfixed test-<svc>   # očekuj Total: 0
  ```

**Provjera:** CI ponovo prođe (zeleno), slike se objave na ghcr.io. Cijeli zapis je u `docs/security/image-scan-report.md`.

**Napomena:** Gate je strog, pa nova ranjivost može srušiti build koji je prije bio zelen, bez promjene koda. Ako popravka nema do roka, zabilježi CVE u `.trivyignore` uz obrazloženje i datum.

---

## Problem 5: Prazan namespace nakon apply / manifesti ne rade

**Simptom:** `kubectl apply -f k8s/` javi da su objekti napravljeni, ali `kubectl get all -n ticketing` pokazuje malo ili nimalo resursa.

**Dijagnoza:**
```bash
wc -l k8s/*.yaml          # datoteka s 0 linija je prazna
grep -rn "image:" k8s/    # očekuj 5 image linija (postgres, redis, api, worker, frontend)
```

**Uzrok:** Jedna ili više manifest datoteka je prazna (sadržaj se nije spremio kod kreiranja), pa apply za njih ništa ne napravi.

**Popravak:** Popuni prazne datoteke ispravnim sadržajem i ponovo primijeni:
```bash
kubectl apply -f k8s/
```

**Provjera:** `wc -l` ne pokazuje datoteke s 0 linija; `kubectl get all -n ticketing` izlista sve Deploymente, Servise, Ingress i NetworkPolicy.

---

## Problem 6: Aplikacija nedostupna s računala (minikube docker driver)

**Simptom:** `curl http://ticketing.local/...` puca u timeout; `ping ticketing.local` se razriješi na `192.168.49.2` ali ima 100% gubitka paketa. Svi podovi su `Running`.

**Dijagnoza:**
```bash
kubectl get ingress -n ticketing     # ADDRESS pokazuje 192.168.49.2 (točno)
ping -n 2 ticketing.local            # 100% gubitka
```

**Uzrok:** Ovo **nije** greška aplikacije ni ingressa. Na minikube **docker driveru** IP klastera (`192.168.49.2`) je na internoj Docker mreži do koje Windows ne može direktno.

**Popravak:** Dođi do klastera preko localhost tunela.
```bash
# Opcija A — pravi ingress preko localhosta:
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80
# dodaj "127.0.0.1 ticketing.local" u hosts, pa otvori http://ticketing.local:18080

# Opcija B — direktan pristup servisu:
minikube service -n ticketing frontend --url
kubectl port-forward -n ticketing svc/api 8080:8080
```

**Provjera:**
```bash
curl http://ticketing.local:18080/api/healthz      # {"status":"ok","service":"api"}
```

---

## Problem 7: Frontend ne učita evente (HTML umjesto JSON-a)

**Simptom:** Sučelje pokaže grešku `Unexpected token '<', "<!doctype "... is not valid JSON`, a padajući izbornik je prazan. API kroz `curl` radi.

**Dijagnoza:** U pregledniku F12 → Network → osvježi. Zahtjev `/config` vraća `Content-Type: text/html` (HTML stranicu) umjesto JSON-a.

**Uzrok:** Jedan Ingress s `rewrite-target` se primjenjivao i na frontend, pa je `/config` bio prepisan u `/` i vraćao `index.html` umjesto pravog `/config` odgovora.

**Popravak:** Razdvojio sam Ingress na dva objekta: jedan za api (s rewriteom) i jedan za frontend (bez rewritea). Tako rewrite vrijedi samo za `/api`.

**Provjera:**
```bash
curl -i http://ticketing.local:18080/config       # Content-Type: application/json, {"apiBaseUrl":"/api"}
```

---

## Problem 8: Pad baze (provjera trajnosti)

**Simptom:** API `/readyz` vraća 503; nove narudžbe stoje u redu; `/tickets/orders` javlja grešku.

**Dijagnoza:**
```bash
kubectl get pods -n ticketing -l app=postgres
kubectl logs deploy/postgres -n ticketing --tail=20
kubectl get pvc -n ticketing                 # PVC mora biti Bound
```

**Uzrok:** Postgres pod je pao ili mu PVC nije povezan.

**Popravak:** Digni Postgres. Pošto podaci leže na PVC-u, restart poda ne gubi spremljene narudžbe.
```bash
kubectl rollout restart deployment/postgres -n ticketing
# ako je PVC zaglavljen u Pending, provjeri storage class:
kubectl get storageclass
```

**Provjera:** Kad je Postgres `Running`, `/readyz` vrati 200, worker sam obradi zaostale narudžbe iz Redisa, a stare narudžbe su i dalje u `/tickets/orders` (dokaz trajnosti).

---

## Brzi popis naredbi

```bash
kubectl get all -n ticketing
kubectl get pods -n ticketing -w
kubectl describe pod <pod> -n ticketing | tail -25
kubectl logs deploy/<svc> -n ticketing --tail=30 [--previous]
kubectl rollout restart deployment/<svc> -n ticketing
kubectl rollout undo deployment/<svc> -n ticketing
kubectl rollout history deployment/<svc> -n ticketing
kubectl get events -n ticketing --sort-by=.lastTimestamp | tail -25
```
