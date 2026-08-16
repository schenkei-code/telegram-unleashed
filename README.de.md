<div align="center">

<img src="assets/banner.png" alt="telegram-unleashed — dein Agent, in deiner Tasche" width="820">

### Dein Agent, in deiner Tasche — und er tippt zurück.

Telegram-Kanal für Claude Code, neu gebaut auf Bot API 10.x.
Antworten, die sich selbst schreiben. Ein Aktivitätsverlauf, der die Arbeit
zeigt, während sie passiert. Formatierung, die nicht zerbricht, Dateien, die
sich wie Dateien verhalten, und Entscheidungen, die ein Daumen erledigt.

[![Version](https://img.shields.io/badge/version-1.6.0-ff8a1e?style=flat-square&labelColor=0f0f12)](https://github.com/schenkei-code/telegram-unleashed/releases)
[![Laufzeit](https://img.shields.io/badge/bun-ohne%20Build--Schritt-ffb43e?style=flat-square&labelColor=0f0f12)](https://bun.sh)
[![Bot API](https://img.shields.io/badge/Bot%20API-10.x-ffd24a?style=flat-square&labelColor=0f0f12)](https://core.telegram.org/bots/api)
[![Lizenz](https://img.shields.io/badge/license-Apache--2.0-9c8657?style=flat-square&labelColor=0f0f12)](LICENSE)

[English](README.md) · **Deutsch**

</div>

---

*Gebaut von **hunch intentional agent**. Ein Fork des offiziellen
`telegram`-Plugins, dessen Zugriffsmodell unverändert übernommen ist.*

## Schnellstart

Sechs Schritte, etwa fünf Minuten. Schritt 5 ist der, den alle übersehen.

### 1. Voraussetzungen

[Claude Code](https://claude.com/claude-code) und [bun](https://bun.sh) — der
Server führt TypeScript direkt aus, es gibt keinen Build-Schritt. Node 20+ nur,
wenn du den optionalen Aktivitätsverlauf willst.

### 2. Bot anlegen

Schreib [@BotFather](https://t.me/botfather), sende `/newbot`, beantworte die
zwei Fragen. Du bekommst einen Token der Form `123456789:AAH...`.

### 3. Token ablegen

Der Token liegt außerhalb des Plugins, damit Updates ihn nie verlieren:

```bash
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=123456789:AAH...' > ~/.claude/channels/telegram/.env
```

Unter Windows ist der Pfad `%USERPROFILE%\.claude\channels\telegram\.env`.

### 4. Plugin installieren

```
/plugin marketplace add schenkei-code/telegram-unleashed
/plugin install telegram-unleashed@hunch
```

Der Marketplace heißt `hunch`, daher das `@hunch` — nicht `@telegram-unleashed`.

Für eine spätere Version:

```
/plugin marketplace update hunch
/plugin update telegram-unleashed@hunch
```

### 5. Claude Code mit angehängtem Kanal starten

```bash
claude --dangerously-load-development-channels plugin:telegram-unleashed@hunch
```

Dieses Flag ist erforderlich. Das Plugin zu installieren lädt seine Werkzeuge,
Senden funktioniert also sofort — eingehende Nachrichten gehen aber nur an eine
Sitzung, die danach gefragt hat. Ohne das Flag kommt nichts an.

`--dangerously-load-development-channels` **ersetzt** `--channels`, es steht
nicht daneben. Die Freigabe gilt pro Eintrag;
[die Doku](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)
sagt: *„Combining this flag with `--channels` doesn't extend the bypass to the
`--channels` entries."* Ein Eintrag in `--channels` wird gegen Anthropics
kuratierte Allowlist geprüft, auf der ein Plugin aus einem eigenen Marketplace
nicht steht — er wird verworfen mit `plugin telegram-unleashed@hunch is not on
the approved channels allowlist`.

Einträge müssen getaggt sein — `plugin:<name>@<marketplace>` oder
`server:<name>`. Ein blankes `telegram-unleashed` wird mit *entries must be
tagged* abgelehnt. Seit Claude Code 2.1.233 nimmt das Flag seine Einträge als
Argumente und bricht ohne sie mit `error: option ... argument missing` ab.

Beim Start erscheint eine Vollbild-Warnung — wähle **I am using this for local
development**. Beide Flags stehen nicht in `claude --help`.

### 6. Koppeln

Schreib deinem Bot eine DM. Er antwortet mit einem Kopplungscode. Zurück in
Claude Code:

```
/telegram-unleashed:access pair <code>
```

Das schreibt deine Nutzer-ID in die Allowlist. Jetzt schreibst du dem Bot, und
die Sitzung antwortet.

> Nur ein Prozess darf einen Bot-Token abrufen. Dieses Plugin parallel zum
> offiziellen `telegram`-Plugin auf demselben Token zu betreiben ergibt einen
> dauerhaften 409 — schalte eines ab, oder gib jedem seinen eigenen Bot.

## Je nach Plattform

Das Plugin selbst ist überall identisch; verschieden sind nur der Ort des
Zustands, die bun-Installation und der Weg, das Kanal-Flag dauerhaft zu setzen.

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash          # falls bun fehlt
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=123456789:AAH...' > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
```

Zustand: `~/.claude/channels/telegram/`.

Damit du das Flag nicht jedes Mal tippst, leg eine Funktion in `~/.zshrc`
(Standard auf macOS) oder `~/.bashrc` (die meisten Linux-Shells) an:

```bash
telegram-unleashed() {
  command claude --dangerously-load-development-channels plugin:telegram-unleashed@hunch "$@"
}
```

Wenn das nackte `claude` den Kanal mitnehmen soll, sichere es so ab, dass nur
der Aufruf ohne Argumente betroffen ist — sonst liefen `claude -p …`,
`claude plugin list` und jeder Aufruf aus einem Skript in den Vollbild-Dialog,
auf dessen Bestätigung dort niemand wartet, und blieben hängen:

```bash
claude() {
  if [ $# -eq 0 ]; then
    telegram-unleashed
  else
    command claude "$@"
  fi
}
```

### Windows

```powershell
powershell -c "irm bun.sh/install.ps1|iex"        # falls bun fehlt
mkdir "$env:USERPROFILE\.claude\channels\telegram" -Force
'TELEGRAM_BOT_TOKEN=123456789:AAH...' | Set-Content "$env:USERPROFILE\.claude\channels\telegram\.env"
```

Zustand: `%USERPROFILE%\.claude\channels\telegram\`.

Die entsprechende Abkürzung gehört ins PowerShell-Profil (`notepad $PROFILE`):

```powershell
function telegram-unleashed {
  claude --dangerously-load-development-channels plugin:telegram-unleashed@hunch @args
}
```

**Eine Einschränkung, die nur Windows betrifft:** Die Übernahme, die den
Bot-Token an deine neueste Sitzung übergibt, ist POSIX-only — sie liest die
Prozesstabelle über `ps` und löst Arbeitsverzeichnisse über `lsof` oder `/proc`
auf, was es dort alles nicht gibt, und wird deshalb komplett übersprungen. Alles
andere funktioniert; was fehlt, ist das automatische Aufräumen, wenn eine
frühere Sitzung einen Poller zurücklässt. Bleiben eingehende Nachrichten aus und
füllt sich das Trace-Log mit `409 Conflict`, beende den alten Prozess von Hand:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object CommandLine -like '*telegram-unleashed*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### Entwicklung gegen einen lokalen Klon

Auf jeder Plattform kannst du den Marketplace auf eine Arbeitskopie zeigen
lassen statt auf GitHub — Änderungen wirken dann ohne Neuinstallation:

```bash
claude plugin marketplace add /absoluter/pfad/zu/telegram-unleashed
claude plugin install telegram-unleashed@hunch
```

Nimm einen absoluten Pfad — eine `~` wird hier nicht aufgelöst und scheitert mit
`ENOENT`. Beachte außerdem: Einen bestehenden Marketplace zu ersetzen wirft das
Plugin aus `enabledPlugins`, deshalb die Install-Zeile danach.

## Was es anders macht

**Die Aktivitätsanzeige überlebt.** Telegram löscht eine Chat-Aktion nach etwa
fünf Sekunden. Ein Zug, der zwei Minuten dauert, zeigte früher fünf Sekunden
„tippt…" und danach nichts mehr — es gab keine Möglichkeit, einen arbeitenden
Agenten von einem toten zu unterscheiden. Hier wird sie in Intervallen
angestoßen, bis wirklich Ausgabe rausgeht.

**Antworten tippen sich selbst.** Kein Spinner, keine Textwand, die auf einmal
landet — die Nachricht setzt sich vor dir zusammen, wie ein Mensch tippt. Kurze
Wörter werden Buchstabe für Buchstabe geschrieben, längere landen am Stück,
damit der Rhythmus gleichmäßig bleibt statt durch jedes lange Substantiv zu
stottern.

Die Taktung läuft im Plugin, und das ist der ganze Trick. Von außen gesteuertes
Streaming kostet eine Runde pro Häppchen und bewegt sich damit im Denktempo des
Aufrufers — ein paar Wörter, eine Pause, ein paar mehr. Gib `reply` den fertigen
Text, und es enthüllt ihn von selbst, gleichmäßig. Gewöhnliche Antworten machen
das standardmäßig; alles mit Anhängen, vorformatiertem Markup oder mehrteiligem
Rumpf wird am Stück gepostet, weil die Enthüllung dort etwas kosten würde statt
gratis zu sein.

**Antworten können auch im Entstehen streamen.** `stream_start` / `stream_push`
/ `stream_end` rendern eine Live-Nachricht über `sendRichMessageDraft` — für
Ausgabe, die es beim ersten Häppchen noch gar nicht gibt. Wo Rich Drafts fehlen,
fällt es automatisch auf Edit-basiertes Streaming zurück, ohne Änderung beim
Aufrufer.

**Du kannst zusehen.** Ein optionaler Hook hält eine Live-Nachricht mit der
Sitzung synchron: jeder gelesene File, jeder Edit, jeder Befehl, verschränkt mit
dem, was der Agent zwischen den Schritten tatsächlich sagt. Ein zweiminütiger
Build hört auf, zwei Minuten Stille zu sein. Er meldet sich nur in Sitzungen,
die eine Telegram-Nachricht gestartet hat — geplante Jobs bleiben still — und
ein Fehler in ihm kann den Zug nie mitreißen. Siehe
[Live-Aktivitätsverlauf](#live-aktivitätsverlauf).

**Nie wieder manuelles Escaping.** Die alte Werkzeugbeschreibung verlangte vom
Aufrufer, die achtzehn reservierten Zeichen von MarkdownV2 von Hand zu
maskieren. Schreib gewöhnliches Markdown; es wird zu gültigem Telegram-HTML, und
alles andere wird maskiert. Ein verirrtes `<`, `&` oder ein unbalanciertes `*`
kann keine Nachricht mehr zerbrechen.

**Code-Blöcke zerbrechen nicht.** Eine lange Nachricht bei 4096 Zeichen zu
teilen schnitt früher durch ein offenes `<pre>`, was Telegram rundheraus
ablehnt. Das Aufteilen ist HTML-bewusst: Jedes an der Schnittstelle noch offene
Tag wird geschlossen und wieder geöffnet.

**Dateien verhalten sich wie Dateien.** Bilder, Video, Audio, Sprachnotizen,
GIFs und Dokumente werden jeweils in ihrer richtigen Form gesendet, und mehrere
Bilder werden ein Album statt acht einzelner Nachrichten. Gegen Telegrams Cloud
liegt die Upload-Grenze bei 50 MB; zeigt `TELEGRAM_API_ROOT` auf einen lokalen
Bot-API-Server, werden daraus 2 GB mit unbegrenzten Downloads.

**Das Gespräch wird erinnert.** Telegram gibt einem Bot nichts als die Updates,
für die er online war — es gibt keine API, um Früheres nachzuladen, und
`getUpdates` vergisst innerhalb eines Tages. Also führt das Plugin sein eigenes
Log: jede Nachricht rein und raus, JSONL, eine Datei pro Chat, neben dem übrigen
Zustand des Kanals. Das `history`-Werkzeug liest und durchsucht es, womit ein
neu gestarteter Agent nachschlagen kann, was er bereits versprochen hat, statt
dich um ein erneutes Einfügen zu bitten. `scripts/backfill-history.mjs` befüllt
das Log aus vorhandenen Claude-Code-Transkripten, damit du beim Einschalten
nicht bei null anfängst.

**Deine Befehle stehen im Menü.** Der blaue Befehlsknopf listet, was Claude Code
tatsächlich installiert hat — jede Skill, jeden Slash-Befehl, beim Start
ermittelt, sodass es richtig bleibt, während du Dinge hinzufügst und entfernst.
Tippe einen an, und die Sitzung führt ihn aus. Telegram verweigert Befehlsnamen
mit Bindestrich oder Doppelpunkt, deshalb wird `claude-mem:mem-search` als
`claude_mem_mem_search` registriert und auf dem Rückweg zurückübersetzt; ohne
das böte das Menü Befehle an, die stillschweigend nichts tun.

Ein angetippter Eintrag ist ein nacktes Wort ohne Raum für Kontext, deshalb
öffnet er eine Karte mit der vollen Beschreibung der Skill und einem
Ausführen-Knopf, statt sofort loszulaufen — der Menütext ist eine beschnittene
Zeile, und das reicht nicht zum Entscheiden. Einen Befehl *mit* Argumenten zu
tippen überspringt die Karte und geht direkt durch.

Ein paar beantwortet das Plugin selbst, ganz ohne Sitzung: `/plugins` listet das
Installierte mit einem Haken daneben — antippen schaltet an oder aus — und
`/model` und `/effort` tun dasselbe für Modell und Denkaufwand, der aktuelle
Wert markiert, der Rest einen Tipp entfernt. `/mcp`, `/commands`, `/history` und
`/status` beantworten Fragen über die Maschine. Alles davon wird in die
Settings-Datei geschrieben, aus der Claude Code startet, wirkt also beim
nächsten Start. Die Zugriffsverwaltung ist bewusst *nicht* auf diesem Weg
erreichbar: Wer mit der Bridge reden darf, wird an der Maschine entschieden, nie
von etwas, das über sie hereinkam.

**Entscheidungen sind ein Tipp.** `ask` postet eine Frage mit Knöpfen und
blockiert, bis einer gedrückt wird. `send_plan` macht dasselbe für einen Plan
und liefert Freigabe oder Ablehnung zurück. Berechtigungsanfragen behalten die
Allow/Deny-Knöpfe des Originals, plus eine ausklappbare Detailansicht.

## Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `reply` | Text und/oder Dateien. Markdown rein, formatierte Nachricht raus. Tippt sich selbst, sofern nichts dagegen spricht. |
| `say` | Einen fertigen Text in gewählter Körnung enthüllen — `natural`, `char`, `word`, `line`, `paragraph`. |
| `send_files` | Dateien ohne Textnachricht; Alben wo passend. |
| `send_code` | Syntaxhervorgehobener Codeblock, sicher geteilt. |
| `ask` | Frage mit Knöpfen — **blockiert bis beantwortet**. |
| `send_plan` | Plan mit Freigeben/Ablehnen — **blockiert bis beantwortet**. |
| `stream_start` / `stream_push` / `stream_end` | Sich live aktualisierende Nachricht. |
| `react` | Emoji-Reaktion (Telegrams feste Auswahl). |
| `edit_message` / `delete_message` / `pin_message` | Nachrichtenverwaltung. |
| `send_poll` | Umfrage. |
| `typing` | Manuelle Steuerung der Anzeige (normalerweise automatisch). |
| `download_attachment` | Eine eingehende Datei in den Posteingang holen. |
| `history` | Lesen oder durchsuchen, was in einem Chat vorher gesagt wurde. |
| `channel_info` | Grenzen, Streaming-Modus, wartende Blockierer. |

## Konfiguration

Der Zustand liegt in `~/.claude/channels/<kanal>/` — Zugangsdaten, Allowlist,
heruntergeladene Anhänge — sodass Neuinstallation oder Update ihn nie berühren.

### Umgebungsvariablen

| Variable | Wirkung |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Erforderlich. Wird aus der `.env` des Kanals gelesen, wenn nicht gesetzt. |
| `TELEGRAM_CHANNEL` | Name des Zustandsverzeichnisses. Standard `telegram`; nimm z. B. `telegram-dev` für einen zweiten Bot. |
| `TELEGRAM_API_ROOT` | Auf einen lokalen Bot-API-Server zeigen, um Dateigrenzen aufzuheben. |
| `TELEGRAM_ACCESS_MODE=static` | Zugriff beim Start einfrieren, nie schreiben. |

### Lokaler Bot-API-Server (optional, für große Dateien)

```bash
# hebt Uploads auf 2 GB und entfernt die 20-MB-Downloadgrenze
telegram-bot-api --api-id=<id> --api-hash=<hash> --local --http-port=8081
export TELEGRAM_API_ROOT=http://localhost:8081
```

Die API-Zugangsdaten kommen von https://my.telegram.org.

## Einstellungen

`~/.claude/channels/<kanal>/access.json`, über die Schlüssel des Originals
hinaus:

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `defaultFormat` | `auto` | `auto` \| `html` \| `markdownv2` \| `text` |
| `typingKeepalive` | `true` | Anzeige während eines Zuges am Leben halten |
| `typingIntervalSec` | `4` | Intervall zum Nachstoßen |
| `typingMaxSec` | `600` | Harte Grenze, damit ein hängender Zug nicht ewig stößt |
| `streaming` | `true` | Live-Streaming von Nachrichten erlauben |
| `streamIntervalMs` | `1200` | Mindestabstand zwischen Stream-Updates |
| `reveal` | `true` | Gewöhnliche Antworten tippen statt am Stück posten |
| `revealUnit` | `natural` | `natural` \| `char` \| `word` \| `line` \| `paragraph` |
| `revealTickMs` | `180` | Abstand zwischen den Bildern der Enthüllung |
| `revealMaxMs` | `3500` | Budget pro Enthüllung; längerer Text nimmt größere Schritte, nicht mehr Zeit |
| `linkPreview` | `false` | Linkvorschauen zeigen |
| `askTimeoutSec` | `900` | Wie lange `ask`/`send_plan` warten |
| `collapseOver` | `0` | Nachrichten über N Zeichen automatisch einklappen (0 = aus) |
| `history` | `true` | Lokales Log jeder Nachricht rein und raus führen |
| `feedMode` | `live` | Form des Aktivitätsverlaufs: `live` (eine Ansicht, am Ende gelöscht) \| `mirror` (Scrollback, bleibt stehen) |

## Live-Aktivitätsverlauf

`hooks/activity.mjs` spiegelt die Sitzung in eine Telegram-Nachricht, die sich
im Verlauf der Arbeit selbst umschreibt — Werkzeugaufrufe und die eigene Prosa
des Agenten, verschränkt. Optional, aus bis du es verdrahtest:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/pfad/zu/telegram-unleashed/hooks/activity.mjs\"", "timeout": 10, "async": true }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"/pfad/zu/telegram-unleashed/hooks/activity.mjs\"", "timeout": 10, "async": true }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"/pfad/zu/telegram-unleashed/hooks/activity.mjs\"", "timeout": 10, "async": true }] }]
  }
}
```

Er liest die Zugangsdaten des Kanals von der Platte und findet den Chat, indem
er im Transkript nach einem eingehenden Kanal-Tag sucht — eine Sitzung, der
niemand geschrieben hat, schreibt also gar nichts, und Cronjobs wie lokale
Arbeit bleiben still. Updates sind gedrosselt, Benachrichtigungen unterdrückt,
und jeder Fehlerpfad endet mit 0: Ein kaputter Verlauf darf den Zug nie
kaputtmachen.

Zwei Modi. Umschalten geht aus dem Chat heraus mit `/feed` — die Karte hat einen
Knopf je Modus, und `/feed off` / `/feed on` sind die getippte Kurzform für
beide. Dasselbe `/feed` gibt es auch als Slash-Befehl in Claude Code, der
Schalter ist also aus dem Terminal erreichbar, das der Feed spiegelt. Der Hook
ist pro Ereignis ein eigener Prozess, eine Änderung greift also beim nächsten
Schritt, ohne Neustart. Der Wert steht als `feedMode` in `access.json`:

| Modus | Bedeutung |
|---|---|
| `live` (Standard) | Der Verlauf ist eine Ansicht. Ein neuer Absatz ersetzt die Karte davor, und der ganze Verlauf wird gelöscht, wenn der Zug endet — was danach stehenbleibt, ist die Antwort allein. |
| `mirror` | Der Verlauf ist Scrollback, so wie ein Terminal Scrollback ist. Nichts wird gelöscht, Denken wird gezeigt, und eine volle Karte bleibt stehen, während die nächste darunter aufgeht. Für das Steuern einer Sitzung vom Telefon aus, wo der Chat das Terminal *sein* muss statt es nur zu zeigen. |

Der Spiegelmodus druckt Werkzeugausgabe nicht vollständig, weil das Terminal es
auch nicht tut — es klappt ein langes Ergebnis ein und zeigt die ersten Zeilen.
Genau dieses Einklappen mitzuspiegeln ist es, was die beiden Ansichten zur
Deckung bringt.

## Nicht enthalten

**Checklisten.** `sendChecklist` verlangt eine `business_connection_id`, also
eine Telegram-Business-Verbindung (Teil von Telegram Premium), bei der der Bot
im Namen eines Nutzerkontos handelt. Das ist ein anderes Produkt als ein
Agentenkanal, ein Checklisten-Werkzeug wäre hier also toter Code. Knöpfe und
Umfragen decken dasselbe Feld ab.

**„Immer erlauben" bei Berechtigungsanfragen.** Das Berechtigungsprotokoll von
Claude Code kennt `allow` und `deny` und sonst nichts. Ein dritter Knopf müsste
über seine eigene Wirkung lügen; dauerhafte Vorabfreigaben gehören in
`permissions.allow` in den Settings.

## Tests

```bash
bun run test/format.test.ts                              # Formatierer und Aufteilung
TELEGRAM_CHANNEL=telegram-dev bun run test/mcp.test.ts <chat_id>   # Ende zu Ende
```

Der Ende-zu-Ende-Test startet den Server über stdio genau so, wie Claude Code es
tut, prüft, dass die Schutzgeländer einen nicht freigegebenen Chat abweisen und
sich weigern, Kanalzustand anzuhängen, und sendet echte Nachrichten.

## Dateien über 20 MB

Telegram deckelt **Bot**-Downloads bei 20 MB. Schickt jemand der Bridge eine
größere Datei, fällt `download_attachment` auf das **eigene Telegram-Konto** des
Nutzers zurück (MTProto über Telethon) — ohne Größengrenze, einmalige
Einrichtung.

Führe die `account`-Skill für die geführte Einrichtung aus: Sie geht durch das
Anlegen von API-Zugangsdaten auf my.telegram.org, eine einmalige interaktive
Anmeldung in deinem eigenen Terminal und vier Zeilen in der `.env` des Kanals.
Die Session-Datei bleibt im Zustandsverzeichnis des Kanals, außerhalb des Repos,
und der Rückfall lädt nur Anhänge herunter, welche die Bridge ohnehin schon
empfangen hat — er sendet nichts.

Alternative für beide Richtungen (bis 2 GB): ein selbst gehosteter
Bot-API-Server über `TELEGRAM_API_ROOT`.

## Wenn nichts ankommt

Dass Ausgehendes funktioniert, während Eingehendes still bleibt, ist der
normale Fehlerfall, und er hat drei übliche Ursachen. Diagnostiziere in dieser
Reihenfolge — jeder Schritt schließt eine Schicht aus.

**1. `~/.claude/channels/telegram/trace.log`** — kam die Nachricht überhaupt bei
der Bridge an?

| Was du siehst | Was es bedeutet |
|---|---|
| gar nichts | Telegram hat sie nie übergeben. Prüfe die nächste Zeile. |
| `409 Conflict, retrying in …` | Ein anderer Poller hält den Token. Siehe unten. |
| `gate -> drop` | Der Absender steht nicht auf der Allowlist. Neu koppeln. |
| `gate -> deliver` und `relayed msg=…` | Die Bridge hat ihre Arbeit getan — das Problem ist die Sitzung. |

**2. Die Sitzung** — sagt das Trace `relayed` und es erscheint trotzdem nichts,
hat die Sitzung den Kanal nie angefordert. Das MCP-Log unter
`~/Library/Caches/claude-cli-nodejs/<projekt>/mcp-logs-plugin-telegram-unleashed-telegram-unleashed/`
(unter Windows `%LOCALAPPDATA%\claude-cli-nodejs\…`) sagt es unverblümt:
`Channel notifications skipped: server … not in --channels list for this
session`. Starte neu mit dem Dev-Flag aus
[Schritt 5](#5-claude-code-mit-angehängtem-kanal-starten) und prüfe, dass es
nicht zusammen mit `--channels` steht.

**3. Ein zurückgebliebener Poller** — `409 Conflict` in Schleife heißt, ein
zweiter Prozess ruft denselben Token ab. Meist ist es eine Sitzung, die du
geschlossen hast und deren Bot sie überlebt hat. Seit 1.4.0 räumt ein startender
Bot diese selbst weg, auch den schweren Fall: Ein Poller, dessen Elternprozess
gestorben ist, wird an init weitergereicht und heißt in der Kommandozeile nur
noch `bun run src/index.ts` — er wird deshalb über sein Arbeitsverzeichnis
gefunden statt über seinen Namen, und hart beendet, wenn er SIGTERM ignoriert.
Zum Selberschauen:

```bash
ps -axo pid=,ppid=,command= | grep '[s]rc/index.ts'
lsof -a -p <pid> -d cwd -Fn        # bestätigen, dass es dieses Plugin ist
```

**Ratenbegrenzung.** `Too Many Requests: retry after <n>` — **`n` sind Sekunden,
keine Millisekunden.** Ein vierstelliger Wert sind Stunden, kein Moment;
dagegen anzusenden verlängert die Sperre nur. Konkurrierende Poller sind die
übliche Ursache: Jeder Neustart veröffentlicht das Befehlsmenü erneut, und diese
Serie zählt Telegram als Flooding. Seit 1.4.0 wird das Menü einmal pro Prozess
veröffentlicht, und der Backoff wird erst zurückgesetzt, wenn eine Verbindung 30
Sekunden gehalten hat — eine Verdrängung liest sich damit nicht mehr wie ein
erfolgreicher Start.

**Rufe nie `getUpdates` auf einem Bot auf, dessen Bridge läuft.** Telegram
liefert jedes Update genau einmal, ein Diagnoseabruf stiehlt dem Plugin also
Nachrichten und reißt seine Verbindung ab. Nimm dafür einen separaten Testbot.

## Lizenz

Apache License 2.0 — siehe [LICENSE](LICENSE) und [NOTICE](NOTICE).

MIT war die Absicht, ist hier aber nicht zu haben: Dies ist ein Fork von
Anthropics offiziellem `telegram`-Plugin, das unter Apache-2.0 steht, und diese
Lizenz lässt sich nicht wegrelizenzieren. Apache-2.0 gewährt dir dieselben
Rechte — nutzen, ändern, weitergeben, kommerziell eingeschlossen — und bringt
zusätzlich eine ausdrückliche Patentgewährung mit. Was sie im Gegenzug verlangt,
ist, dass der Hinweis mit dem Code mitreist und Änderungen benannt werden, was
`NOTICE` tut.

---

<div align="center">

<img src="assets/hunch.png" alt="hunch · intentional agent" width="380">

*Agenten, die aus Absicht handeln, nicht auf Zuruf.*

</div>
