# Asked & Answered

Even G2 glasses that recall answers a family already gave, without generating new answers.

Role B's speech implementation is in [`server/src/speech`](server/src/speech). ElevenLabs Scribe v2 Realtime is the selected provider; Deepgram Nova-3 and an offline scripted provider are also available. See the [speech setup and integration guide](server/README.md).

```powershell
cd server
npm ci
npm test
npm run speech:demo
```

This checkout implements the speech layer. The glasses app, hosted server/store/matcher, and Creao integration remain the other roles' deliverables. The original [team plan](LA%20Hacks%20Team%20Plan.md), [build guide](Build%20Guide.md), and [folder structure](folder-structure.md) define those boundaries.
