"""Minimal smoke test — run after docker build to verify the container."""

import sys
import requests

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"

def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}" + (f": {detail}" if detail else ""))
    if not condition:
        sys.exit(1)

print(f"\nNinja Docling Service — Smoke Tests ({BASE_URL})\n")

# Test 1: Health
r = requests.get(f"{BASE_URL}/health", timeout=10)
check("GET /health returns 200", r.status_code == 200)
check("status is ok", r.json().get("status") == "ok")
check("model field present", "model" in r.json())

# Test 2: Missing file
r = requests.post(f"{BASE_URL}/detect",
    json={"pdfPath": "/nonexistent/file.pdf", "jobId": "smoke-001"},
    timeout=10)
check("Missing file returns 422", r.status_code == 422)

# Test 3: Invalid body
r = requests.post(f"{BASE_URL}/detect",
    json={"wrongField": "value"},
    timeout=10)
check("Invalid body returns 422", r.status_code == 422)

print("\nAll smoke tests passed.\n")
