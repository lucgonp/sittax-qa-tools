' Roda o vigia de QA Review no WSL sem abrir janela de console.
' --auto-reject: PR sem teste automatizado -> reprova e move para Rejected sem gastar IA.
CreateObject("Wscript.Shell").Run "wsl.exe -d Ubuntu-26.04 -- bash -lc ""cd ~/sittax-qa-review && node qa-review.mjs --queue --new-only --auto-reject >> /tmp/qa-watch.log 2>&1""", 0, False
