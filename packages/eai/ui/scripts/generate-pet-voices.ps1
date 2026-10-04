<#
  PHOSPHOR · PET voice asset generator (Windows-only — System.Speech is a
  Windows API). NOT part of the runtime; a one-time (well, one-time-per-edit)
  build step. Bakes ui/src/pet-lines.json into static .wav files under
  ui/public/pet-voices/<lang>/<mood>-<index>.wav, so the shipped app plays a
  fixed recording instead of calling the end user's live SpeechSynthesis — the
  whole point being that the app then never depends on whichever OS/browser
  voices happen to be installed on whoever's machine it runs on (that
  dependency is exactly what caused ja-JP text to come out in a zh-TW voice
  when only a system-default voice, with no explicit voice selected, was used).

  Re-run this after editing pet-lines.json:
    powershell -File ui/scripts/generate-pet-voices.ps1
#>

Add-Type -AssemblyName System.Speech

$linesPath = Join-Path $PSScriptRoot '..\src\pet-lines.json'
$outRoot   = Join-Path $PSScriptRoot '..\public\pet-voices'
$lines     = Get-Content -Raw -Encoding UTF8 $linesPath | ConvertFrom-Json

$voiceFor = @{ en = 'Microsoft Zira Desktop'; ja = 'Microsoft Haruka Desktop' }
$xmlLang  = @{ en = 'en-US'; ja = 'ja-JP' }
$pitch    = @{ en = '+15%'; ja = '+30%' }

foreach ($lang in @('en', 'ja')) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voiceFor[$lang])

  $dir = Join-Path $outRoot $lang
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  foreach ($mood in $lines.$lang.PSObject.Properties) {
    for ($i = 0; $i -lt $mood.Value.Count; $i++) {
      $text = $mood.Value[$i]
      $file = Join-Path $dir ("$($mood.Name)-$i.wav")
      $ssml = "<speak version=`"1.0`" xmlns=`"http://www.w3.org/2001/10/synthesis`" xml:lang=`"$($xmlLang[$lang])`"><prosody pitch=`"$($pitch[$lang])`" rate=`"+5%`">$text</prosody></speak>"
      $synth.SetOutputToWaveFile($file)
      $synth.SpeakSsml($ssml)
      $synth.SetOutputToNull()
      Write-Output "wrote $file"
    }
  }
  $synth.Dispose()
}
Write-Output "done"
