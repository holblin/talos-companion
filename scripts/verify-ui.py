"""Exercise UI state boundaries with synthetic fixtures and capture grading evidence."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:5175")
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / "dist" / "ui-review" / "qualification"
out.mkdir(parents=True, exist_ok=True)
user = dict(id="demo-admin", name="Demo Admin", email="admin@example.test", admin=True)
settings = dict(retention=dict(recovery_keep_last=7, snapshot_keep_last=30), schedule=dict(enabled=True, interval_seconds=86400, destination="local"))
overview = dict(settings=settings, issuer="https://companion.example.test", client_id="omni", client_secret="demo-only", redirect_uri="https://omni.example.test/callback", s3_endpoint="https://s3.example.test", s3_access_key="demo-only", s3_secret_key="demo-only", bucket="omni", mounted=None, drive=dict(client_id="", folder_id="", connected=False), retention=settings["retention"], streaming_backups=True)
backups = [dict(name=f"companion-{1794078000 - day * 86400}-abcd1234.tcb", bytes=(7-day)*1048576) for day in range(3)]
results = []

def fixtures(route, state):
    path = route.request.url.split("/api/")[1]
    if path == "users" and state.get("fail_users"):
        route.fulfill(status=503, json={"error": "Accounts service unavailable"})
        return
    if path == "backups" and state.get("fail_backups"):
        route.fulfill(status=503, json={"error": "Recovery storage unavailable"})
        return
    data = {"status": {"initialized": state.get("mode") != "setup"}, "me": user, "overview": overview, "users": [user], "vault": [], "backups": [] if state.get("mode") == "empty" else backups, "companion/access": {"accesses": [], "active_issuer": overview["issuer"]}}.get(path, {})
    if path == "me" and state.get("mode") == "sign-in":
        route.fulfill(status=401, json={"error": "Sign in required"})
    else:
        route.fulfill(json=data)

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in [320, 390, 768, 1024, 1440]:
        for mode in ["dashboard", "empty", "sign-in", "setup"]:
            state = dict(mode=mode)
            context = browser.new_context(viewport=dict(width=width, height=900), is_mobile=width < 768, has_touch=width < 768)
            context.route("**/api/**", lambda route: fixtures(route, state))
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(args.url)
            page.get_by_role("heading").first.wait_for()
            if mode == "dashboard":
                page.get_by_text("3 encrypted", exact=True).wait_for()
            elif mode == "empty":
                page.get_by_role("heading", name="Your first backup starts here.").wait_for()
            page.wait_for_timeout(250)
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), (width, mode, "overflow")
            assert not errors, errors
            if width in [390, 1440]:
                page.screenshot(path=str(out / f"{mode}-{width}.png"), full_page=True)
            if mode == "dashboard":
                if width < 1024:
                    page.get_by_role("button", name="Workspace page").click()
                    page.get_by_role("option", name="Backups", exact=True).click()
                else:
                    page.get_by_role("link", name="Backups", exact=True).click()
                page.get_by_role("heading", name="Your recovery files", exact=True).wait_for()
                page.wait_for_timeout(350)  # Let the S2 picker dismissal finish before captures.
                assert page.evaluate("document.activeElement.tagName") == "H1"
                if width in [390, 1440]:
                    page.screenshot(path=str(out / f"backups-{width}.png"), full_page=True)
                page.get_by_role("button", name="Backup destinations and schedule", exact=True).click()
                trigger = page.get_by_role("button", name="Set up Google Drive", exact=True)
                trigger.click()
                page.get_by_role("heading", name="Connect Google Drive", exact=True).wait_for()
                assert page.evaluate("document.activeElement.tagName") == "H2"
                page.get_by_role("button", name="Close setup", exact=True).click()
                assert trigger.evaluate("el => el === document.activeElement")
                assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), (width, "expanded setup overflow")
            results.append(dict(width=width, mode=mode, passed=True, errors=errors))
            context.close()

    for failure in ["users", "backups"]:
        state = {f"fail_{failure}": True}
        context = browser.new_context(viewport=dict(width=1440, height=1000))
        context.route("**/api/**", lambda route: fixtures(route, state))
        page = context.new_page()
        page.goto(args.url)
        label = "Retry accounts" if failure == "users" else "Retry recovery files"
        page.get_by_role("button", name=label, exact=True).wait_for()
        assert page.get_by_text("0 encrypted", exact=True).count() == 0
        assert page.get_by_text("Needs setup", exact=True).count() == 0
        assert page.get_by_role("heading", name="Your first backup starts here.").count() == 0
        if failure == "users":
            page.get_by_text("3 encrypted", exact=True).wait_for()
        page.screenshot(path=str(out / f"failed-{failure}.png"), full_page=True)
        state[f"fail_{failure}"] = False
        page.get_by_role("button", name=label, exact=True).click()
        page.get_by_text("Workspace data loaded", exact=True).wait_for()
        page.get_by_text("3 encrypted", exact=True).wait_for()
        results.append(dict(scenario=f"independent {failure} error and retry", passed=True))
        context.close()

    state = {}
    context = browser.new_context(viewport=dict(width=1440, height=1000))
    context.route("**/api/**", lambda route: fixtures(route, state))
    page = context.new_page()
    page.goto(args.url)
    page.get_by_text("3 encrypted", exact=True).wait_for()
    page.get_by_role("button", name="Connect Google Drive", exact=True).click()
    page.get_by_role("heading", name="Connect Google Drive", exact=True).wait_for()
    assert page.evaluate("document.activeElement.id") == "google-drive"
    assert page.url.endswith("/settings#google-drive")
    page.screenshot(path=str(out / "settings-1440.png"), full_page=True)
    page.goto(args.url)
    page.get_by_text("3 encrypted", exact=True).wait_for()
    page.get_by_role("link", name="Skip to main content", exact=True).focus()
    assert page.evaluate("document.activeElement.textContent") == "Skip to main content"
    assert page.get_by_role("link", name="Skip to main content", exact=True).bounding_box()["y"] >= 0
    page.keyboard.press("Enter")
    assert page.evaluate("document.activeElement.tagName") == "H1"
    # CSS zoom exercises enlarged text/layout; this is not a physical-device or browser-zoom certification.
    page.evaluate("document.body.style.zoom = '200%'")
    page.wait_for_timeout(300)
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "200% CSS zoom overflow"
    page.screenshot(path=str(out / "zoom-200.png"), full_page=True)
    results.append(dict(scenario="Drive destination focus, skip link and 200% CSS zoom", passed=True))
    context.close()
    browser.close()

(out / "checks.json").write_text(json.dumps(results, indent=2))
print(f"Passed {len(results)} browser scenarios. Evidence: {out}")
