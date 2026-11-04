Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
$s.SetOutputToWaveFile("$PSScriptRoot\public\speech.wav")
$s.Speak("Can you hear me through the wall? The blue door is on the left, and the key is under the third stone. If you can make out these words, the wall is thin. Count with me: seven, four, nine, two. Whatever you do, keep your voice down, because something in the next room is sleeping.")
$s.Dispose()
