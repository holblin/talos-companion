"""Record repeatable UI tours against synthetic API fixtures, never live data."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("phase", choices=["before", "after"])
parser.add_argument("--url", default="http://127.0.0.1:5174")
parser.add_argument("--out", type=Path, help="Directory for this comparison's recordings")
parser.add_argument("--check", action="store_true", help="Check responsive layouts and navigation instead of recording")
args = parser.parse_args()
out = args.out.resolve() if args.out else Path(__file__).resolve().parents[1] / "dist" / "ui-review"
out.mkdir(parents=True, exist_ok=True)
user = dict(id="demo-admin", name="Demo Admin", email="admin@example.test", admin=True)
settings = dict(retention=dict(recovery_keep_last=7, snapshot_keep_last=30), schedule=dict(enabled=True, interval_seconds=86400, destination="local"))
overview = dict(settings=settings, issuer="https://companion.example.test", client_id="omni", client_secret="demo-only", redirect_uri="https://omni.example.test/callback", s3_endpoint="https://s3.example.test", s3_access_key="demo-only", s3_secret_key="demo-only", bucket="omni", mounted=None, drive=dict(client_id="", folder_id="", connected=False), retention=settings["retention"], streaming_backups=True)
backups = [dict(name=f"companion-{1794078000 - day * 86400}-abcd1234.tcb", bytes=(7-day) * 1048576) for day in range(3)]

def route_api(route):
    path = route.request.url.split("/api/")[1]
    data = {"status": {"initialized": True}, "me": user, "overview": overview, "users": [user], "vault": [], "backups": backups, "companion/access": {"accesses": [], "active_issuer": overview["issuer"]}}.get(path, {})
    route.fulfill(status=200, content_type="application/json", body=json.dumps(data))

with sync_playwright() as p:
    browser = p.chromium.launch()
    if args.check:
        results = []
        for width in [320, 390, 768, 1024, 1440]:
            for mode in ["dashboard", "sign-in", "setup", "empty"]:
                context = browser.new_context(viewport=dict(width=width, height=900), is_mobile=width < 768, has_touch=width < 768, device_scale_factor=1)
                context.route("**/api/**", route_api)
                if mode == "setup":
                    context.route("**/api/status", lambda route: route.fulfill(json={"initialized": False}))
                elif mode == "sign-in":
                    context.route("**/api/me", lambda route: route.fulfill(status=401, json={"error": "Sign in required"}))
                elif mode == "empty":
                    context.route("**/api/backups", lambda route: route.fulfill(json=[]))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(args.url)
                page.get_by_role("heading").first.wait_for()
                page.wait_for_timeout(350)
                overflow = page.evaluate("document.documentElement.scrollWidth > innerWidth")
                assert not overflow, f"Horizontal overflow: {width}px {mode}"
                assert not errors, errors
                if width in [390, 1440] and mode in ["setup", "sign-in"]:
                    page.screenshot(path=str(out / f"{mode}-{width}.png"), full_page=True)
                if mode == "empty":
                    page.get_by_role("heading", name="Your first backup starts here.").wait_for()
                if mode == "dashboard":
                    page.keyboard.press("Tab")
                    assert page.evaluate("document.activeElement !== document.body"), "No keyboard focus"
                    if width < 1024:
                        page.get_by_role("button", name="Workspace page").click()
                        page.get_by_role("option", name="Settings", exact=True).click()
                    else:
                        page.get_by_role("link", name="Settings", exact=True).click()
                    page.get_by_role("heading", name="Make yourself at home.").wait_for()
                results.append(dict(width=width, mode=mode, horizontal_overflow=overflow, page_errors=errors, passed=True))
                context.close()
        (out / "browser-checks.json").write_text(json.dumps(results, indent=2))
        print(f"Passed {len(results)} responsive browser scenarios.")
        browser.close()
        raise SystemExit(0)
    for device, size in [("desktop", dict(width=1440, height=1000)), ("mobile", dict(width=390, height=844))]:
        context = browser.new_context(viewport=size, record_video_dir=str(out / "raw"), record_video_size=size, is_mobile=device == "mobile", has_touch=device == "mobile", device_scale_factor=1)
        context.route("**/api/**", route_api)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        page.get_by_role("heading", name="Everything in its place.").wait_for()
        page.get_by_text("3 encrypted", exact=True).wait_for()
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(out / f"{device}-{args.phase}.png"), full_page=True)
        for amount in [360, 360, -720]:
            page.mouse.wheel(0, amount)
            page.wait_for_timeout(1000)
        page.get_by_role("button", name="Manage your backups").click()
        page.get_by_role("heading", name="A way back, always.").wait_for()
        page.wait_for_timeout(1400)
        for amount in [500, 500, -1000]:
            page.mouse.wheel(0, amount)
            page.wait_for_timeout(1000)
        overflow = page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        assert not overflow, f"Horizontal overflow in {device} recording"
        (out / f"{device}-{args.phase}.json").write_text(json.dumps(dict(errors=errors, horizontal_overflow=overflow), indent=2))
        video = page.video
        context.close()
        video.save_as(str(out / f"{device}-{args.phase}.webm"))
    browser.close()
