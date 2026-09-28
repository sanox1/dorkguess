BTC price flipper DAPP, play on the dorkcoin blockchain.

https://dorkexplorer.com/ - explorer, https://coin.dorkcoingames.com/ - website, https://dorkcoingames.com/ - dork arcade

How to deploy:

- You need to install and run NODE.JS and install DORKCORE WALLET GUI QT version in Windows.
- In DORKCORE WALLET you need to open : %APPDATA%\Dorkcoin\dorkcoin.conf and add these lines: server=1 rpcport=22555 rpcuser=your_user rpcpassword=Your_pass
- In NODE.JS you need AXIOS, EXPRESS, CORS etc. installed, e.g. run npm install axios
- Replace RPC_USER and RPC_PASS with your own into the backend js file
- Replace password Token secret 'your_dorkguess_secret' with your own
- You can now run your backend script server.js with NODE.JS - node server.js
- You need to open port 5502 (or any free port if 5502 is busy) in your router where the backend is, so your server is available outside.
- If you are running multiple backends that use the same DORKCOIN wallet, make sure they use different ports.
You can host the frontend index and login HTML in any hosting. Change your API_URL to match your dorkcore_server_ip:5502(or any free port if 5502 is busy)

Features:

UTXO Blockchain (DORK/Dogecoin-like) - Uses JSON-RPC to communicate with DORKCORE wallet

User storage - JSON files with username/wallet, password hash, score, lives, entry price

BTC price prediction - UP/DOWN prediction, 1-minute lock-in

Scoring - +1 correct, -1 incorrect, 5 points = 10 DORK reward (you can change this)

Lives reset - Daily at 12:00 UTC

Address validation - 34 chars, starts with 'D'

Mini chart to display price range in the last 15 minutes

DISCLAIMER: NO WARRANTY, USE AT YOUR OWN RISK! THIS IS MADE JUST FOR FUN AND TO LEARN AND I AM NOT RESPONSIBLE FOR ANY STOLEN FUNDS / FINANCIAL LOSS! IF YOU DEPLOY AND USE THESE SCRIPTS YOU SHOULD NEVER KEEP A LOT OF $DORK IN YOUR DORKCORE NODE RPC SERVER.

This project is open-source and contributions are welcome!
