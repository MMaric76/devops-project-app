# Troubleshooting Runbook — Secure Event Ticketing Platform

This runbook covers diagnosing and recovering from the most common failure modes of the platform in the Kubernetes (`ticketing` namespace) and CI/CD environments. Each entry follows the same shape: **symptom → diagnosis → root cause → fix → validation**.

All incidents below are real failures encountered while building and deploying this project; the commands and error messages are the actual ones used to resolve them.

---

## 0. General triage (start here for any incident)

```bash
# What is unhealthy?
kubectl get pods -n ticketing

# Why is a specific pod unhealthy? (events at the bottom are the key part)
kubectl describe pod <pod-name> -n ticketing | tail -25

# What is the application logging?
kubectl logs deploy/<api|worker|frontend|postgres|redis> -n ticketing --tail=30
# add --previous to see logs from a crashed/restarted container:
kubectl logs <pod-name> -n ticketing --previous

# Recent cluster-wide events, newest last:
kubectl get events -n ticketing --sort-by=.lastTimestamp | tail -25
```

Health endpoints for the API:
- `GET /healthz` — liveness; returns 200 if the process is up.
- `GET /readyz` — readiness; returns 200 only if **both** Postgres and Redis respond. A 503 here means a backing service is down.

---

## Incident 1: Pods never created — `FailedCreate ... serviceaccount not found`

**Symptom:** A Deployment shows `READY 0/1`, but `kubectl get pods -l app=<svc>` returns *no pod at all* (not even Pending).

**Diagnosis:**
```bash
kubectl describe rs -n ticketing -l app=<svc> | tail -20
```
Events show:
```
Error creating: pods "..." is forbidden: error looking up service account
ticketing/ticketing-sa: serviceaccount "ticketing-sa" not found
```

**Root cause:** Every Deployment sets `serviceAccountName: ticketing-sa`. If the RBAC manifest (`03-rbac.yaml`) that defines that ServiceAccount was not applied (or was applied after the Deployments), Kubernetes refuses to create the pods.

**Fix:**
```bash
kubectl apply -f k8s/03-rbac.yaml          # ensure the ServiceAccount exists
kubectl rollout restart deployment/<svc> -n ticketing   # retry pod creation
```

**Validation:** `kubectl get pods -n ticketing` now shows the pod moving through `ContainerCreating → Running`.

**Prevention:** apply the whole `k8s/` folder at once (`kubectl apply -f k8s/`); ordering inside a single apply is handled, but never skip the RBAC file.

---

## Incident 2: Worker in `CrashLoopBackOff` — database not reachable

**Symptom:** The `worker` pod cycles `Running → Error → CrashLoopBackOff` with a rising restart count, while `redis` and `frontend` are healthy.

**Diagnosis:**
```bash
kubectl logs deploy/worker -n ticketing --tail=20
```
```
Worker fatal error: Error: connect ECONNREFUSED 10.x.x.x:5432
  code: 'ECONNREFUSED', address: '10.x.x.x', port: 5432
```

**Root cause:** On startup the worker runs `SELECT 1` against Postgres. If Postgres is not yet `Running`/`Ready`, the connection is refused and the worker exits; Kubernetes restarts it, producing the crash loop. (In this project the underlying reason Postgres was down was Incident 1 — its pod had never been created.)

**Fix:** Bring Postgres up first, then let the worker recover.
```bash
kubectl get pods -n ticketing -l app=postgres     # confirm Postgres status
# once Postgres is Running 1/1:
kubectl rollout restart deployment/worker -n ticketing   # force immediate retry
```

**Validation:** A fresh worker pod reaches `Running 1/1` with `0` restarts. Logs show `Worker started and waiting for jobs...`.

**Note:** A few worker restarts while Postgres is still starting are normal — the worker self-recovers once the database is Ready. Only investigate if it never settles.

---

## Incident 3: `ImagePullBackOff` / `ErrImagePull`

**Symptom:** `api`, `worker`, or `frontend` pods stay `0/1` with status `ImagePullBackOff`.

**Diagnosis:**
```bash
kubectl describe pod <pod-name> -n ticketing | tail -20
```
Look at the failing image reference in the Events. Two common causes:

1. **Bad image name** — e.g. a leftover placeholder (`ghcr.io/YOUR_GH_USERNAME/...`) or uppercase characters (OCI image names must be lowercase; `MMaric76` is invalid → must be `mmaric76`).
2. **Private package** — the image exists in ghcr.io but the registry rejects the pull because the package is private and the cluster has no pull secret.

**Fix:**
- For a bad name, correct it in the manifests and re-apply:
  ```bash
  grep -rn "image:" k8s/                 # verify all 5 image lines are correct
  kubectl apply -f k8s/
  ```
- For a private package, either make the package **Public** (GitHub → Packages → package → visibility), or create a pull secret and reference it:
  ```bash
  kubectl create secret docker-registry ghcr-cred -n ticketing \
    --docker-server=ghcr.io --docker-username=<user> --docker-password=<token>
  # then add imagePullSecrets: [{ name: ghcr-cred }] to the pod spec
  ```

**Validation:** `kubectl get pods -n ticketing` shows the image pulled and the pod `Running`.

---

## Incident 4: CI pipeline fails at the Trivy scan (quality gate)

**Symptom:** The GitHub Actions job builds the image successfully but fails at the **Trivy scan** step with `exit code 1`; the image is **not** pushed.

**Diagnosis:** Open the failed job → "Trivy scan" step. A vulnerability table lists HIGH/CRITICAL CVEs with a `Fixed Version`.

**Root cause:** This is the quality gate working as designed — the gate is configured to fail the build on fixable HIGH/CRITICAL vulnerabilities, blocking a vulnerable image from being published.

**Fix (remediate, don't bypass):**
- CVEs in `tar` bundled inside npm → npm is not needed at runtime, so it is removed from the runtime image (`rm -rf /usr/local/lib/node_modules/npm ...`).
- OS-package CVEs (e.g. OpenSSL `libcrypto3`/`libssl3`) → patch at build time (`apk -U upgrade`).
- Re-scan locally before pushing:
  ```bash
  docker build -t test-<svc> ./<svc>
  trivy image --severity HIGH,CRITICAL --ignore-unfixed test-<svc>   # expect Total: 0
  ```

**Validation:** CI re-runs green; images are pushed to ghcr.io. See `docs/security/image-scan-report.md` for the full remediation record.

**Note:** Because the gate is strict, a newly disclosed CVE can fail a previously-green build with no code change. If no fix exists at deadline, record the CVE in a `.trivyignore` with a justification and review date.

---

## Incident 5: Empty namespace after apply / manifests not taking effect

**Symptom:** `kubectl apply -f k8s/` reports objects created, but `kubectl get all -n ticketing` shows few or no resources.

**Diagnosis:**
```bash
wc -l k8s/*.yaml          # any file at 0 lines is empty/truncated
grep -rn "image:" k8s/    # expect 5 image lines (postgres, redis, api, worker, frontend)
```

**Root cause:** One or more manifest files were empty (content not saved when created), so `kubectl apply` silently created nothing for them.

**Fix:** Populate the empty files with the correct content and re-apply:
```bash
kubectl apply -f k8s/
```

**Validation:** `wc -l` shows no zero-line files; `kubectl get all -n ticketing` lists all Deployments, Services, Ingress, and NetworkPolicies.

---

## Incident 6: Application not reachable from the host (minikube docker driver)

**Symptom:** `curl http://ticketing.local/...` times out; `ping ticketing.local` resolves to `192.168.49.2` but reports 100% packet loss. Pods are all `Running`.

**Diagnosis:**
```bash
kubectl get ingress -n ticketing     # ADDRESS shows 192.168.49.2 (correct)
ping -n 2 ticketing.local            # 100% loss
```

**Root cause:** This is **not** an application or ingress fault. On the minikube **docker driver**, the cluster IP (`192.168.49.2`) is on an internal Docker network that Windows cannot route to directly.

**Fix:** Reach the cluster through a localhost tunnel instead.
```bash
# Option A — exercise the real ingress via localhost:
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80
# add "127.0.0.1 ticketing.local" to the hosts file, then browse http://ticketing.local:18080

# Option B — direct service access:
minikube service -n ticketing frontend --url
kubectl port-forward -n ticketing svc/api 8080:8080
```

**Validation:**
```bash
curl http://ticketing.local:18080/api/healthz      # {"status":"ok","service":"api"}
```

---

## Incident 7: Database outage (durability check)

**Symptom:** API `/readyz` returns 503; new purchases sit in the queue; `/tickets/orders` errors or returns stale data.

**Diagnosis:**
```bash
kubectl get pods -n ticketing -l app=postgres
kubectl logs deploy/postgres -n ticketing --tail=20
kubectl get pvc -n ticketing                 # PVC should be Bound
```

**Root cause:** Postgres pod down, or its PersistentVolumeClaim unbound.

**Fix:** Restore Postgres. Because data lives on a PVC, restarting the pod does not lose committed orders.
```bash
kubectl rollout restart deployment/postgres -n ticketing
# if the PVC is stuck Pending, check the storage class:
kubectl get storageclass
```

**Validation:** Once Postgres is `Running`, `/readyz` returns 200, the worker drains the Redis backlog automatically, and previously-committed orders are still present in `/tickets/orders` (proving persistence).

---

## Quick command reference

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
