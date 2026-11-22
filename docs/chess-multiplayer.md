# Chess multiplayer demo

The local demo uses a PartyKit lobby for online players and invites, followed
by a separate PartyKit room for each chess game.

## Run two demo players

Install the PartyKit dev dependency and start its local server:

```sh
cd party
bun install
bun run dev
```

Start the app dev server in another terminal. Vite proxies the app's secure
WebSocket connection to the local PartyKit server on port `1999`.

Open two isolated browser profiles at:

```text
https://localhost:5181/?chessDemoUser=alice
https://localhost:5181/?chessDemoUser=bob
```

In both sessions, power on the terminal and open Chess with **Ctrl+K → Games →
Chess**. On Alice, choose **Play with someone**, select
**Demo Bob**, and send the invite. Bob gets an **Accept / Decline** card. When
Bob accepts, both sessions join the same game room and can play opposite
colors.

The query parameter only creates a local development identity. These are not
Cyberspace accounts, and this mode does not use or transmit a Cyberspace token.
The lobby is intentionally unauthenticated and accepts the user IDs supplied
by its clients; use it only for local testing. Do not deploy it as a public
service.

## Integration boundary

`ChessMultiplayerTransport` in
[`app/src/chess/multiplayer.ts`](../app/src/chess/multiplayer.ts) separates the
menu and board from the transport. The Cyberspace owner can replace the demo
adapter with authenticated endpoints for:

```text
listFriends()       -> authenticated follower/profile API
sendInvite()        -> create invite and game id
watchInvites()      -> deliver inbound invites
answerInvite()      -> accept or decline
openGame()          -> authenticated realtime game stream
submitMove()        -> server-validated move command
watch()             -> authoritative game snapshots
```

For a real service, authenticate each socket server-side and derive the user ID
from the verified session. Never trust the demo `userId` field or forward one
player's bearer token to another player.

The PartyKit hosted platform shut down on 23 October 2026. This starter uses
only the local PartyKit dev server; public deployment should use PartyServer
with Wrangler instead.
