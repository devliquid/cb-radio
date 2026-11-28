# Breaker 40 CB: Radio Manual

Version {{version}}

Breaker 40 CB is a push-to-talk radio for your computer. Everyone who connects to the same base station can talk to each other. Pick a channel, hold the talk button, and talk.

## Getting on the air

1. Open the radio. The first time, SETUP opens by itself.
2. Type a **handle**, the name other people see when you talk.
3. The radio connects to the hosted base station on its own. The **NET** lamp lights when you're connected.
4. Pick a channel. Channel 19 on the 11 meter band is where most people are.
5. Hold **PUSH TO TALK** (or the Space bar), talk, and let go to listen.

## The front panel

### VOLUME

How loud the speaker is. Drag the knob up or down, scroll the mouse wheel over it, or click it and use the arrow keys.

### SQUELCH

Turn it all the way down to hear the static of an open band. Turn it up for silence between transmissions.

### USB / OFF / LSB switch

The sideband switch. **OFF** is AM, which is how most CB talk works. **USB** and **LSB** are single sideband (upper and lower), a narrower, cleaner-sounding mode.

- Sideband radios only understand each other on the same sideband. If you're on USB and the other person is on LSB, their voice comes out back to front.
- An AM radio hears a sideband station as garble ("Donald Duck").
- A sideband radio hears an AM station with a carrier whistle under the voice.
- The mode you're on shows next to the frequency on the display.

Click a label, click the slot, scroll over it, or click it and use the arrow keys.

### CLARIFIER

Fine-tunes single sideband voices. Each sideband station is a little off frequency, so its voice sounds high-pitched (like a chipmunk) or low-pitched (like a slowed-down tape). Turn the clarifier slowly until the voice sounds natural. It only matters on USB and LSB. Double-click the knob to centre it.

### Meter

The S-meter shows how strong the signal you're hearing is. While you transmit, it shows your RF power instead.

### Display

- **RX** lights while you're receiving, **TX** while you're transmitting.
- **NET** lights when you're connected to a base station, and blinks while the radio is looking for one.
- **SCAN** lights while the radio is scanning.
- The big red digits are the channel. Under them are the frequency and the mode (AM, USB or LSB).
- The line under the display tells you who's talking, how many others are on your channel, and who you heard last.

### Band strip

The row of 40 small lights under the display is every channel on the band you're on. Green means people are listening there, red means someone is talking. Click one to go to that channel.

### CHANNEL ▲ and ▼

Change the channel up or down. Hold a button to keep going. The Up and Down arrow keys and the mouse wheel do the same. After channel 40 it goes round to channel 1.

### Band screen

Shows which band you're on (10, 11 or 12 meter), with the band's frequency range under it.

### BAND switch: 10, 11, 12

Picks the band. Each band has its own 40 channels, so the radio has 120 in all:

- **11 meter** is CB: 26.965 to 27.405 MHz, the channels everyone knows (9 is emergency, 19 is the highway channel).
- **10 meter** is 28.305 to 28.695 MHz, in steps of 10 kHz.
- **12 meter** is 24.890 to 24.9875 MHz, in steps of 2.5 kHz.

You only hear people on the same band and channel. In real life, 10 and 12 meters are amateur (ham) bands that need a licence. In Breaker 40 they're simply more channels on the base station.

### CH 9 and CH 19

Jump straight to channel 9 (emergency) or channel 19 (highway) on the 11 meter band.

### SCAN

Sweeps the channels on your band and stops on any channel where someone is talking. It waits there 3 seconds after they stop, then carries on. Press SCAN again, change channel or start talking to stop it.

### ROGER

When it's on (green light), the radio sends a roger beep when you let go of the talk button, so others know you're done. Pick the sound in SETUP, under **Roger beep**. The TX lamp stays lit until the beep has gone out.

### ECHO and the echo slider

An echo mic: everyone on the channel hears your voice repeat. Press ECHO to turn it on or off. The slider sets how much, from one faint repeat to a long, ringing echo. Moving the slider also turns echo on. You don't hear your own echo, just like with a real echo mic.

### HANDLE plate

Shows your handle. Change it in SETUP.

### SETUP

Opens the settings. See below.

## The microphone

- **Classic theme:** hold the red **PUSH TO TALK** button on the hand mic.
- **Silver base station theme:** hold the white **PUSH TO TALK** bar on the desk mic's base.
- **Army themes:** hold the black press-to-talk bar on the handset's grip.
- **Old tube radio theme:** hold the brass **PUSH TO TALK** button on the microphone stand's base.
- Holding the push-to-talk key (Space unless you changed it) does the same.
- Like a real radio, you can't hear anyone while you're transmitting.
- The mic lets go by itself after 3 minutes, so a stuck key can't block the channel.

## SETUP

Every computer keeps its own settings, and they're still there after a restart.

### Your handle

The name others see when you talk, up to 16 letters.

### Saved base stations

A list of base stations you use. It starts with **Render (hosted)**, the hosted base station. To add one, type its address, give it a name and click **Save to list**. Pick one from the list to connect to it. **Delete** removes the selected one.

### Base station address

The base station you're connected to. Everyone on the same base station can hear each other. You can enter:

- `wss://` and a domain, such as `wss://breaker40-base-station.onrender.com`
- just a domain name (the radio adds `wss://`)
- `ws://` with an IP address and port, such as `ws://192.168.1.20:7140`
- just an IP address (the radio adds port 7140)

Click **Connect** to switch.

### Be the base station

Tick **Host on port** to run a base station on this computer. The radio lists the addresses others can use. On the same Wi-Fi, they enter one of those. To reach you from the internet, forward that TCP port on your router to this computer.

### Audio

- **Microphone** and **Speaker:** pick devices, or leave them on the default. If a device is unplugged, the radio goes back to the default.
- **Mic level:** talk normally and watch the bar.
- **Mic gain:** adjust it until the level bar sits in the green, below the dashed line. That's how loud others will hear you.

### Roger beep

Pick the sound your radio sends when you let go of the talk button. There are 10 built in: Classic two-tone, Single beep, Two-tone falling, Triple chirp, Bumblebee trill, Sweep up, Sweep down, Morse K (go ahead), Morse R (roger) and Space sweep. Picking one plays it, and turns ROGER on. **Play** plays it again.

To use your own sound, click **Add a WAV file…** and pick a .wav file. The radio trims silence off both ends, evens out the volume and keeps up to 3 seconds. Your sounds appear under **Your sounds** in the list, and **Remove** deletes the one that's picked. You can keep up to 20.

### Look

**Theme** changes how the radio looks:

- **Classic:** a black mobile rig with a hand mic.
- **Silver base station:** a silver tabletop radio with a desk mic.
- **Army green:** an olive drab field radio with green night-vision displays and a military handset.
- **Army camouflage:** the same field radio in woodland camouflage.
- **Old tube radio:** a walnut cabinet with a brass name plate, ivory buttons, a warm amber glow and a chrome microphone on a stand.

### Push-to-talk key

Click **Change…** and press the key you want. Esc cancels. Tab and Enter can't be used, because they move around the window.

### Manual

This manual. Read it in SETUP, or open it as a text document or a PDF.

### Updates

Shows the version you have and the latest version. **Check for updates** downloads a newer version, closes the radio, installs it and opens the radio again. The portable version and the Linux .deb can't update themselves, so for those it opens the download page.

## Base stations

The radio starts on the hosted base station, so there's nothing to set up. You can also run your own:

- On any computer: tick **Be the base station** in SETUP.
- On a Windows server: run **Breaker40-BaseStation.exe** from the download page. It shows the addresses to use and who's on.
- On a Linux server: run the Linux base station from the download page.

The hosted base station runs on a free plan. If nobody has used it for about 15 minutes it goes to sleep, and the first radio to connect waits up to a minute while it wakes up. Leave the radio on; it keeps trying by itself.

## Keyboard

- **Space** (or your push-to-talk key): hold to talk.
- **Up / Down arrows:** channel up and down.
- **Esc:** close SETUP.
- On a knob or switch you clicked: the arrow keys turn it.

## When something's wrong

- **NET keeps blinking:** the radio can't reach the base station. Check the address in SETUP and your internet connection. The hosted base station can take up to a minute to wake up.
- **Nobody hears me:** check the mic level in SETUP while you talk, and that the right microphone is picked. Make sure you're on the same band, channel and mode as the others.
- **I hear garble or a chipmunk voice:** someone is on a different mode. Match their USB, LSB or AM setting, then use the CLARIFIER.
- **No sound at all:** turn up VOLUME, check the speaker in SETUP, and turn SQUELCH down to hear static.
- **Windows warns about the app:** the app isn't code-signed. Click **More info**, then **Run anyway**.
