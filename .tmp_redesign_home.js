// One-shot, guarded edit of lib/student_dashboard.dart (home redesign).
const fs = require("fs");
const crypto = require("crypto");
const FILE = "D:/scep - Copy/lib/student_dashboard.dart";
const raw = fs.readFileSync(FILE, "utf8");
const crlf = raw.includes("\r\n");
let s = raw.replace(/\r\n/g, "\n");
const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
if (process.argv[2] && process.argv[2] !== hash) throw new Error("file changed since inspection: " + hash);
console.log("hash", hash);

// Index just past the bracket that matches the opener at `open`.
function matchEnd(str, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const o = str[open], c = pairs[o];
  let depth = 0, i = open, inStr = null;
  for (; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "/" && str[i + 1] === "/") { i = str.indexOf("\n", i); continue; }
    if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced at " + open);
}
function uniq(needle, from = 0, to = s.length) {
  const a = s.indexOf(needle, from);
  if (a < 0 || a >= to) throw new Error("missing: " + needle.slice(0, 60));
  const b = s.indexOf(needle, a + 1);
  if (b >= 0 && b < to) throw new Error("not unique: " + needle.slice(0, 60));
  return a;
}
// Replace a whole method `  Widget name(...) { ... }` (signature included).
function replaceMethod(sig, body) {
  const a = uniq("\n  " + sig) + 1;
  const brace = s.indexOf("{", s.indexOf(")", a));
  const end = matchEnd(s, brace);
  s = s.slice(0, a) + body.trim() + s.slice(end);
}
// Replace an expression starting at `needle` (which ends with the opener).
function replaceExpr(needle, from, to, repl, tail = "") {
  const a = uniq(needle, from, to);
  const open = a + needle.indexOf("(");
  let end = matchEnd(s, open);
  if (tail && s.startsWith(tail, end)) end += tail.length;
  s = s.slice(0, a) + repl + s.slice(end);
}
function methodRange(sig) {
  const a = uniq("\n  " + sig) + 1;
  const brace = s.indexOf("{", s.indexOf(")", a));
  return [a, matchEnd(s, brace)];
}

// ── 1. Trip status strip ───────────────────────────────────────────────────
replaceMethod("Widget _buildStatusStrip() {", `
  Widget _buildStatusStrip() {
    // Redesigned (TripStatusCard). Values/logic unchanged: _isBusOnline,
    // busSpeed and etaText (from _recomputeEta()).
    return TripStatusCard(
      tripActive: _isBusOnline,
      tripLabel: _isBusOnline ? "Trip Active" : "Trip Ended",
      speedText: "\${busSpeed.toStringAsFixed(0)} km/h",
      etaText: etaText.isEmpty ? "—" : etaText,
    );
  }
`);

// ── 2. Route card: empty state + main card ─────────────────────────────────
{
  let [a, b] = methodRange("Widget _routeCard() {");
  replaceExpr("      return Container(", a, b, `      return const RouteInformationCard.empty(
          message: "Select a bus to view route information");`, ";");
  [a, b] = methodRange("Widget _routeCard() {");
  replaceExpr("    return Container(", a, b, `    final bool isOffline = _gpsState == "OFFLINE";
    return RouteInformationCard(
      distanceText: showDistance
          ? (_gpsState == "LIVE"
              ? "\${displayDistance.toStringAsFixed(1)} km"
              : "≈ \${displayDistance.toStringAsFixed(1)} km")
          : null,
      dimmed: isOffline,
      currentLabel: isOffline ? "LAST KNOWN LOCATION" : "CURRENT LOCATION",
      currentValue: displayCurrent,
      nextLabel: isOffline ? "NEXT SCHEDULED STOP" : "NEXT STOP",
      nextValue: displayNextStop,
      // GPS freshness row — only this rebuilds via ValueListenableBuilder.
      footer: ValueListenableBuilder<int>(
        valueListenable: _gpsAgeNotifier,
        builder: (_, age, __) => AnimatedSwitcher(
          duration: const Duration(milliseconds: 300),
          child: _buildFreshnessRow(age),
        ),
      ),
    );`, ";");
}
// The old inline content builder is now part of RouteInformationCard.
{
  const [a, b] = methodRange("Widget _routeCardUnifiedContent(");
  // drop the preceding section comment line too
  const cm = s.lastIndexOf("\n  // ── Route card: unified content", a);
  s = s.slice(0, cm >= 0 && a - cm < 120 ? cm + 1 : a) + s.slice(b).replace(/^\n/, "");
  if (s.includes("_routeCardUnifiedContent")) throw new Error("still referenced");
}

// ── 3. Reconnecting row → golden spinning indicator ────────────────────────
{
  const [a, b] = methodRange("Widget _buildFreshnessRow(int age) {");
  replaceExpr("      return Row(\n        key: const ValueKey(\"reconnecting\"),", a, b,
    `      return Row(
        key: const ValueKey("reconnecting"),
        children: [
          ScepSpinningIcon(color: ScepColors.gold, size: 18.sp),
          SizedBox(width: 8.w),
          Text("Reconnecting…",
              style: TextStyle(
                  color: ScepColors.gold,
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w700)),
        ],
      )`, "");
}

// ── 4. Driver + bus selector cards ─────────────────────────────────────────
replaceMethod("Widget _driverCard() {", `
  Widget _driverCard() {
    // Redesigned (DriverInformationCard). Name/mobile/route come from the
    // existing backend fields; the tap still opens the phone dialer.
    return DriverInformationCard(
      driverName: driverName,
      driverMobile: driverMobile,
      routeName: busRouteName,
      onCall: () async {
        if (driverMobile.isNotEmpty) {
          final intent = AndroidIntent(
            action: 'android.intent.action.DIAL',
            data: 'tel:$driverMobile',
          );
          await intent.launch();
        }
      },
    );
  }
`);
replaceMethod("Widget _busSelectorCard() {", `
  Widget _busSelectorCard() {
    // Redesigned (SelectBusCard). Same states as before: loading, error with
    // Retry (only when the list is empty), otherwise Change/Choose bus. The
    // whole card opens the existing selection sheet via _onBusCardTap.
    return SelectBusCard(
      selectedBus: selectedBus,
      loading: _busListLoading,
      errorText: (_busListError != null && busList.isEmpty) ? _busListError : null,
      onRetry: _fetchBusList,
      onTap: _onBusCardTap,
    );
  }
`);

// ── 5. Support & Help entry ────────────────────────────────────────────────
replaceMethod("Widget _supportEntry(BuildContext context) {", `
  Widget _supportEntry(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 4.h, 16.w, 8.h),
      child: ScepEntryCard(
        icon: Icons.support_agent_rounded,
        title: "Support & Help",
        subtitle: "Report issues or chat with admin",
        onTap: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const SupportTicketScreen())),
      ),
    );
  }
`);

// ── 6. Map floating controls ───────────────────────────────────────────────
replaceExpr("child: GestureDetector(\n            onTap: () => setState(() => isFullScreen = !isFullScreen),",
  0, s.length, `child: MapControlButton(
            onTap: () => setState(() => isFullScreen = !isFullScreen),
            child: Icon(
              isFullScreen
                  ? Icons.fullscreen_exit_rounded
                  : Icons.fullscreen_rounded,
              size: 24.sp,
              color: ScepColors.darkNavy,
            ),
          )`);
replaceExpr("child: GestureDetector(\n              onTap: _manualRefreshBusLocation,",
  0, s.length, `child: MapControlButton(
              onTap: _manualRefreshBusLocation,
              child: _isRefreshingLocation
                  ? SizedBox(
                      width: 18.w,
                      height: 18.w,
                      child: const CircularProgressIndicator(
                          strokeWidth: 2, color: ScepColors.darkNavy),
                    )
                  : Icon(Icons.refresh_rounded,
                      size: 24.sp, color: ScepColors.darkNavy),
            )`);

// ── 7. Profile header card (photo + name + bus badge) ──────────────────────
replaceMethod("Widget _profileHeaderCard({double topMargin = 0}) {", `
  Widget _profileHeaderCard({double topMargin = 0}) {
    final String headerPhotoUrl = _studentPhotoUrl;
    final bool showPhoto = _studentPhotoUrl.isNotEmpty && !_studentPhotoBroken;
    return Padding(
      padding: EdgeInsets.only(top: topMargin),
      child: GestureDetector(
        onTap: () => _openProfileScreen(),
        child: ScepBlueCard(
          gradient: ScepGradients.deep,
          padding: EdgeInsets.fromLTRB(14.w, 14.h, 14.w, 14.h),
          child: Row(
            children: [
              // Gold + white ring around the profile photo.
              Container(
                padding: const EdgeInsets.all(2),
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(
                      colors: [ScepColors.gold, ScepColors.brightYellow]),
                ),
                child: Container(
                  width: 50.w,
                  height: 50.w,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: ScepColors.royalBlue,
                    border: Border.all(color: Colors.white, width: 2),
                    image: showPhoto
                        ? DecorationImage(
                            image: NetworkImage(_studentPhotoUrl),
                            fit: BoxFit.cover,
                            onError: (_, __) =>
                                _onStudentPhotoError(headerPhotoUrl),
                          )
                        : null,
                  ),
                  child: showPhoto
                      ? null
                      : Icon(Icons.person_rounded,
                          color: Colors.white, size: 26.sp),
                ),
              ),
              SizedBox(width: 14.w),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      "Welcome Back",
                      style: TextStyle(
                        color: ScepColors.secondaryLightBlue,
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    SizedBox(height: 1.h),
                    Text(
                      studentName.isEmpty ? "Loading..." : studentName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 19.sp,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
              if (selectedBus.isNotEmpty)
                Container(
                  padding:
                      EdgeInsets.symmetric(horizontal: 10.w, vertical: 5.h),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(ScepRadii.pill.r),
                    border: Border.all(color: ScepColors.gold, width: 1.5),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.directions_bus_rounded,
                        color: ScepColors.gold, size: 13.sp),
                    SizedBox(width: 4.w),
                    Text(
                      selectedBus,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ]),
                ),
            ],
          ),
        ),
      ),
    );
  }
`);

// ── 8. Page background + imports ───────────────────────────────────────────
s = s.split("backgroundColor: const Color(0xfff0f4ff),").join("backgroundColor: ScepColors.iceBlue,");
const imp = "import 'theme/app_accent.dart';\n";
if (!s.includes(imp)) throw new Error("import anchor");
s = s.replace(imp, imp + "import 'theme/scep_theme.dart';\nimport 'widgets/home/home_cards.dart';\n");

fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, "\r\n") : s, "utf8");
console.log("written");
