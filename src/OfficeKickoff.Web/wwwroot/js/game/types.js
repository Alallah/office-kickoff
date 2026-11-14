// =====================================================================================
//  MATCH PAGE MODULE CONTRACTS (JSDoc only - this file contains no runtime code).
//
//  The match page is four cooperating modules. game/main.js owns the frame loop and is the
//  only module that talks to the others; the others never import each other.
//
//      main.js  --builds a FrameView every frame-->  renderer.render(view)
//         |                                           audio.update(view)
//         |                                           hud.update(view)
//         '--forwards game events:                    renderer.onEvent, audio.onEvent, hud.onEvent
//
//  Message shapes (MatchInit, RoomState, MatchResult, ...) are documented in
//  src/OfficeKickoff.Web/Protocol/Dtos.cs; they arrive in camelCase.
//
//  The page: Views/Room/Match.cshtml is <main id="app" data-room="CODE"> containing
//  <canvas id="game"> and <div id="hud">. Ownership of the canvas:
//    - css/match.css (HUD engineer) sizes it: body.page-match { overflow: hidden },
//      #game { position: fixed; inset: 0; width: 100%; height: 100%; display: block }.
//    - main.js measures canvas.clientWidth / clientHeight on load and on resize and calls
//      renderer.resize(width, height, devicePixelRatio).
//    - only the renderer ever writes canvas.width / canvas.height.
//
//  Screen layout, so the canvas minimap and the DOM overlays never collide:
//    top-centre scoreboard | top-left event feed | top-right ping and connection |
//    bottom-left chat and emote bar | bottom-centre ability bar |
//    bottom-right the renderer's minimap (16 px inset, at most 220 x 150 CSS px) - HUD keeps it empty.
// =====================================================================================

/**
 * One footballer as drawn this frame (already interpolated / predicted).
 * @typedef {Object} PlayerView
 * @property {number} i          index in the match (same as the snapshot / MatchInit.players)
 * @property {number} team       0 = home (attacks towards +x), 1 = away
 * @property {number} slot       0 = goalkeeper
 * @property {boolean} keeper
 * @property {string} name       roster name
 * @property {number} number     shirt number
 * @property {number} x @property {number} y     world position
 * @property {number} vx @property {number} vy   world velocity (units/s)
 * @property {number} aim        facing, radians
 * @property {number} action     ACTION.* (see shared/protocol.js)
 * @property {number} actionT    seconds left of the action
 * @property {number} actionDir  radians: direction of the current slide / dash / dive
 * @property {number} stamina    0..1
 * @property {number} charge     0..1 shot charge (0 when not charging)
 * @property {number} cd         tackle / dash cooldown, seconds left
 * @property {number} flags      PLAYER_FLAG bits
 * @property {number} ctrl       human id controlling this footballer, -1 = AI
 * @property {?HumanInfo} human  the controlling human, or null for AI
 * @property {boolean} isMe      controlled by the local player
 * @property {boolean} hasBall
 */

/**
 * @typedef {Object} HumanInfo   (MatchInit.humans entry; the list is fixed for the whole match)
 * @property {number} humanId @property {number} memberId
 * @property {string} name @property {number} team
 * @property {string} color      "#rrggbb" accent colour
 * @property {string} celebration
 */

/**
 * Everything about one frame. Built by main.js, read-only for everyone else.
 * @typedef {Object} FrameView
 * @property {number} now         wall clock seconds (performance.now() / 1000)
 * @property {number} dt          wall seconds since the previous frame (clamped to 0.1)
 * @property {number} time        match timeline being shown, in server seconds (tick / 60)
 * @property {number} phase       PHASE.*
 * @property {number} phaseTime   real seconds left in the phase
 * @property {number} clock       seconds of regulation left (practice: seconds played)
 * @property {number[]} score     [home, away]
 * @property {boolean} overtime   golden goal in progress
 * @property {boolean} slowMo     post-goal slow motion
 * @property {{x:number,y:number,vx:number,vy:number,speed:number,spin:number,owner:number,heat:number,held:boolean,dead:boolean}} ball
 * @property {PlayerView[]} players
 * @property {{humanId:number, memberId:number, team:number, spectator:boolean, playerIndex:number, player:?PlayerView, autoSwitch:boolean}} me
 *           Spectators: humanId = -1, team = -1, spectator = true, playerIndex = -1, player = null.
 *           A PLAYER can also have playerIndex = -1 and player = null for a while: before their first
 *           input reaches the server, while their window is in the background (the AI has their
 *           footballer), and on the results screen. Every module must cope with player === null.
 * @property {{x:number,y:number}} aim        mouse cursor in world coordinates
 * @property {number} passTarget              footballer a pass would go to right now, -1 = none / not applicable
 * @property {{x:number,y:number,zoom:number}} camera   world point at the centre of the screen, and scale
 * @property {{w:number,h:number}} viewport   canvas size in CSS pixels
 * @property {?{progress:number}} replay      non-null while a goal replay is on screen (progress 0..1). See REPLAYS.
 * @property {object} init        MatchInitDto for this match
 * @property {object} room        latest RoomStateDto
 * @property {number} ping        round-trip ms, -1 unknown
 * @property {'connected'|'reconnecting'|'disconnected'} connection
 *           'reconnecting' is also reported when no snapshot has arrived for a second during a running match.
 *
 * World -> screen (CSS pixels), identical in every module:
 *     sx = (wx - camera.x) * camera.zoom + viewport.w / 2
 *     sy = (wy - camera.y) * camera.zoom + viewport.h / 2
 *
 * REPLAYS. While view.replay is non-null:
 *   - players, ball, time and me.player show the buffered past (the goal being replayed);
 *   - phase stays PHASE.REPLAY; phaseTime, clock, score and overtime stay LIVE (the score already
 *     includes the goal); slowMo is false;
 *   - buffered events from the replayed window are delivered again with evt.replay === true, to
 *     renderer.onEvent and audio.onEvent ONLY. The HUD never receives replayed events.
 *
 * EVENTS. Every server event is delivered exactly once, when the drawn timeline reaches it, in the
 * order renderer, audio, hud. Events for the local player's own actions are delivered early, at the
 * moment of the key press, with evt.predicted === true, and the server's copy is then dropped.
 * For EVT.GOAL always unpack the flag with goalInfo(evt) from shared/protocol.js: the scorer's
 * human comes from there, not from the footballer's current controller.
 */

/**
 * game/render/renderer.js  ->  export function createRenderer(canvas): Renderer
 * Draws the world and all in-world effects on one <canvas>. Screen shake and other purely visual
 * camera offsets are the renderer's own business and must never affect aiming.
 * @typedef {Object} Renderer
 * @property {(cssWidth:number, cssHeight:number, dpr:number) => void} resize   the only place canvas.width/height are written
 * @property {(init:object) => void} setMatch          new match: rebuild cached layers, clear effects
 * @property {(view:FrameView) => void} render
 * @property {(evt:import('../shared/protocol.js').GameEvt, view:FrameView) => void} onEvent
 * @property {(playerIndex:number, emoji:string) => void} showEmote   bubble above a footballer
 * @property {() => void} reset                        drop transient effects (trails, particles, scuffs, bubbles) but keep
 *                                                     cached layers. main.js calls it when everything teleports: at every
 *                                                     kickoff reset, when a replay starts and when it ends.
 */

/**
 * game/audio.js  ->  export function createAudio(): AudioEngine
 * All sound is synthesised with the Web Audio API (no audio files).
 * @typedef {Object} AudioEngine
 * @property {() => void} unlock                  starts / resumes the AudioContext. main.js calls it at boot and again on
 *                                                every pointer or key event; it must be cheap and safe to call repeatedly,
 *                                                and must cope with a context the browser keeps suspended until a gesture.
 * @property {(volume:number) => void} setVolume  0..1
 * @property {(muted:boolean) => void} setMuted
 * @property {(init:object) => void} setMatch
 * @property {(view:FrameView) => void} update    every frame: crowd bed, charge tone, ...
 * @property {(evt:import('../shared/protocol.js').GameEvt, view:FrameView) => void} onEvent
 * @property {(name:'click'|'hover'|'open'|'close'|'chat'|'emote'|'error'|'countdown'|'go', value?:number) => void} ui
 *           Interface sounds, triggered by the HUD. For 'countdown', value is the number being shown
 *           (3, 2, 1): pitch rises as it falls. The audio engine never plays the countdown by itself.
 */

/**
 * game/hud.js  ->  export function createHud(root, actions): Hud
 * Everything that is DOM rather than canvas: scoreboard, clock, countdown, big banners (GOAL,
 * GOLDEN GOAL, FULL TIME), intro splash, replay badge, event feed, chat, emote bar, ability bar,
 * pause menu (volume, mute, auto-switch, controls), controls overlay, connection notice, results.
 * @typedef {Object} Hud
 * @property {(init:object, room:object, memberId:number) => void} setMatch   new match (also removes a results screen)
 * @property {(room:object) => void} onRoomState     re-evaluate everything that depends on the room (host-only buttons!)
 * @property {(view:FrameView) => void} update
 * @property {(evt:import('../shared/protocol.js').GameEvt, view:FrameView) => void} onEvent   never called with replayed events
 * @property {(chat:object) => void} onChat          ChatDto (system announcements arrive here too)
 * @property {(emote:object) => void} onEmote        EmoteDto
 * @property {(result:object) => void} showResults   MatchResultDto
 * @property {() => void} hideResults                removes the results screen (main.js calls it when a rematch starts)
 * @property {() => boolean} capturesInput           true while the chat box is focused or a menu is open:
 *                                                   main.js then feeds neutral controls to the game
 *
 * @typedef {Object} HudActions   callbacks the HUD may call; implemented by main.js as stated
 * @property {(text:string) => void} chat             invokes hub Chat(text)
 * @property {(index:number) => void} emote           invokes hub Emote(index)
 * @property {(volume:number) => void} setVolume      audio.setVolume + savePrefs({ volume })
 * @property {(muted:boolean) => void} setMuted       audio.setMuted + savePrefs({ muted })
 * @property {(on:boolean) => void} setAutoSwitch     invokes hub SetProfile({ autoSwitch: on }) + savePrefs({ autoSwitch: on })
 * @property {() => void} rematch                     invokes hub Rematch() (the server ignores non-hosts)
 * @property {() => void} backToLobby                 invokes hub BackToLobby() (the server ignores non-hosts)
 * @property {() => void} leave                       invokes hub Leave(), then goes to ROUTES.home()
 * @property {(name:string, value?:number) => void} uiSound   audio.ui(name, value)
 * @property {() => {volume:number, muted:boolean, autoSwitch:boolean}} getPrefs   from shared/identity.js getPrefs()
 */

export {};
