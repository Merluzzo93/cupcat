<?php
// Receives a CupCat feedback bundle and tells the developer it arrived.
//
// The app builds a ZIP on the user's machine (report.json, a screenshot, the project document, the
// engine log, system info) and posts it here. This stores it and sends an email with the details and
// a link — a link rather than an attachment, because a multi-megabyte attachment from a shared host
// gets rejected or filed as spam often enough that the report would simply never arrive.
//
// On protection, plainly: CupCat is open source, so any secret compiled into it is readable by
// anyone who wants it. There is therefore no token here pretending to be one. What actually holds is
// a size cap, a per-address rate limit, and a check that the upload really is a CupCat bundle —
// enough that abusing this is more effort than it is worth, without the false comfort of a password
// published alongside the lock.
//
// Bundles are kept under an unguessable folder name and deleted after RETENTION_DAYS. They can
// contain a screenshot of whatever the user had on screen, so they are not something to leave lying
// around indefinitely.

declare(strict_types=1);

const MAIL_TO         = 'cupcat@meetaly.agency';
const MAIL_FROM       = 'cupcat@meetaly.agency';   // same domain as this server, so SPF passes
const MAX_BYTES       = 32 * 1024 * 1024;          // a bundle is a few MB; 32 is generous
const MAX_PER_IP_DAY  = 10;
const RETENTION_DAYS  = 30;
const REPORTS_DIR     = __DIR__ . '/reports';

header('Content-Type: application/json; charset=utf-8');

function fail(int $code, string $why): never {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $why]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST a bundle here; there is nothing to see.');
}

// ---- rate limit -------------------------------------------------------------------------------
// One counter file per address per day. Cheap, needs no database, and self-expires because the name
// carries the date.
$ip    = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$state = REPORTS_DIR . '/.state';
// The two directories need DIFFERENT permissions, so they are created separately. Creating .state
// recursively in one call gave its 0700 to the parent as well, and the web server — which is not
// the user PHP runs as — could then not read anything inside: every download link in every email
// came back 403. The counters stay private; what has to be served must be traversable.
if (!is_dir(REPORTS_DIR) && !@mkdir(REPORTS_DIR, 0755) && !is_dir(REPORTS_DIR)) {
    fail(500, 'Storage is not writable.');
}
@chmod(REPORTS_DIR, 0755); // repair an install that predates this
if (!is_dir($state) && !@mkdir($state, 0700) && !is_dir($state)) {
    fail(500, 'Storage is not writable.');
}
$counter = $state . '/' . date('Ymd') . '-' . hash('sha256', $ip) . '.count';
$sent    = (int) @file_get_contents($counter);
if ($sent >= MAX_PER_IP_DAY) {
    fail(429, 'Too many reports from here today. Try again tomorrow, or email the file directly.');
}

// ---- the upload -------------------------------------------------------------------------------
if (!isset($_FILES['bundle']) || $_FILES['bundle']['error'] !== UPLOAD_ERR_OK) {
    // UPLOAD_ERR_INI_SIZE means the server's own limit is below ours — worth saying so rather than
    // reporting a generic failure the user can do nothing about.
    $e = $_FILES['bundle']['error'] ?? -1;
    fail(400, $e === UPLOAD_ERR_INI_SIZE || $e === UPLOAD_ERR_FORM_SIZE
        ? 'The bundle is larger than this server accepts.'
        : 'No bundle received.');
}
$tmp  = $_FILES['bundle']['tmp_name'];
$size = (int) $_FILES['bundle']['size'];
if ($size <= 0 || $size > MAX_BYTES) {
    fail(413, 'Bundle is empty or too large.');
}

// It must actually be a CupCat bundle: a ZIP, containing the report the app writes. This is what
// stops the endpoint being useful as free file storage.
if (@file_get_contents($tmp, false, null, 0, 4) !== "PK\x03\x04") {
    fail(415, 'That is not a ZIP.');
}
// Look for the report the app writes. ZipArchive would be the obvious way and is NOT installed on
// every shared host — testing found it missing here, which silently skipped this check altogether
// and let a ZIP of anything through. A ZIP keeps its file names as plain text in the directory at
// the end of the file, so the tail is enough and needs no extension at all.
$tail = (string) @file_get_contents($tmp, false, null, max(0, $size - 262144));
if (strpos($tail, 'report.json') === false) {
    fail(415, 'That is not a CupCat report.');
}

// ---- store ------------------------------------------------------------------------------------
$id  = bin2hex(random_bytes(16));           // unguessable: the link is the only way in
$dir = REPORTS_DIR . '/' . $id;
if (!@mkdir($dir, 0755, true) && !is_dir($dir)) {
    fail(500, 'Could not store the bundle.');
}
$stamp = date('Ymd-His');
$dest  = $dir . "/cupcat-report-$stamp.zip";
if (!@move_uploaded_file($tmp, $dest)) {
    fail(500, 'Could not store the bundle.');
}
@file_put_contents($counter, (string) ($sent + 1));

// Keep the folder from being browsable even if the host has listings on.
@file_put_contents(REPORTS_DIR . '/index.html', '');
@file_put_contents(REPORTS_DIR . '/.htaccess', "Options -Indexes\n");

// ---- housekeeping -----------------------------------------------------------------------------
// A bundle can contain a picture of someone's desktop; it should not live here forever.
$cutoff = time() - RETENTION_DAYS * 86400;
foreach ((array) @glob(REPORTS_DIR . '/*', GLOB_ONLYDIR) as $old) {
    if (basename($old) === '.state' || @filemtime($old) > $cutoff) continue;
    foreach ((array) @glob($old . '/*') as $f) @unlink($f);
    @rmdir($old);
}
foreach ((array) @glob($state . '/*.count') as $c) {
    if (@filemtime($c) < time() - 3 * 86400) @unlink($c);
}

// ---- tell the developer -----------------------------------------------------------------------
// Truncation without mbstring: it is not installed everywhere either (it was missing on the machine
// this was written on), and cutting UTF-8 by bytes leaves a mangled character at the end. Cut by
// bytes, then drop any incomplete character left dangling.
$cut = static function (string $s, int $max): string {
    if (strlen($s) <= $max) return $s;
    $s = substr($s, 0, $max);
    while ($s !== '' && (ord($s[strlen($s) - 1]) & 0xC0) === 0x80) $s = substr($s, 0, -1);
    if ($s !== '' && (ord($s[strlen($s) - 1]) & 0xC0) === 0xC0) $s = substr($s, 0, -1);
    return $s;
};
$clean = static fn (string $s, int $max): string =>
    $cut(preg_replace('/[\r\n]+/', ' ', strip_tags($s)) ?? '', $max);

$type        = $clean((string) ($_POST['type'] ?? 'other'), 40);
$version     = $clean((string) ($_POST['version'] ?? '?'), 40);
$platform    = $clean((string) ($_POST['platform'] ?? '?'), 60);
$description = $cut(strip_tags((string) ($_POST['description'] ?? '')), 4000);

$scheme = (($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['SERVER_PORT'] ?? '') === '443') ? 'https' : 'http';
$base   = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'cupcat.meetaly.agency') . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? ''), '/\\');
$link   = $base . '/reports/' . $id . '/' . rawurlencode(basename($dest));

$body = "A CupCat report has arrived.\n\n"
      . "Type:        $type\n"
      . "Version:     $version\n"
      . "Platform:    $platform\n"
      . "Size:        " . round($size / 1048576, 2) . " MB\n"
      . "Received:    " . date('Y-m-d H:i:s') . "\n\n"
      . "What they wrote\n---------------\n" . ($description !== '' ? $description : '(nothing)') . "\n\n"
      . "Bundle: $link\n"
      . "(report.json, screenshot.png, project.json, logs.txt, system.txt — deleted after "
      . RETENTION_DAYS . " days)\n";

@mail(
    MAIL_TO,
    "CupCat $type — $version",
    $body,
    "From: CupCat <" . MAIL_FROM . ">\r\nReply-To: " . MAIL_FROM . "\r\nContent-Type: text/plain; charset=utf-8\r\n"
);

echo json_encode(['ok' => true, 'id' => $id]);
