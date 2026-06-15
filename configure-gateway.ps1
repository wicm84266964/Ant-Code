param(
  [string]$GatewayUrl = "",
  [string]$Model = "",
  [string]$ApiKey = "",
  [string]$Protocol = "openai-chat",
  [string]$HealthUrl = "",
  [string]$NetworkMode = "approved-web",
  [string[]]$ExtraAllowedHosts = @(),
  [string]$Label = "",
  [int]$ContextTokens = 200000,
  [string]$ConfigPath = "",
  [switch]$Thinking,
  [switch]$NoVerify,
  [switch]$NoEnvWrite,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

function Read-Required([string]$Prompt, [string]$Current = "") {
  if ($Current -and $Current.Trim().Length -gt 0) {
    return $Current.Trim()
  }
  do {
    $value = Read-Host $Prompt
    $value = "$value".Trim()
  } while ($value.Length -eq 0)
  return $value
}

function Read-Optional([string]$Prompt, [string]$Default = "") {
  $suffix = if ($Default) { " [$Default]" } else { "" }
  $value = Read-Host "$Prompt$suffix"
  $value = "$value".Trim()
  if ($value.Length -eq 0) {
    return $Default
  }
  return $value
}

function Read-Secret([string]$Prompt, [string]$Current = "") {
  if ($Current -and $Current.Trim().Length -gt 0) {
    return $Current.Trim()
  }
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Get-HostFromUrl([string]$Url) {
  try {
    return ([Uri]$Url).Host
  } catch {
    throw "Gateway URL is not valid: $Url"
  }
}

function New-AntCodeGatewayConfig(
  [string]$GatewayUrl,
  [string]$HealthUrl,
  [string]$Model,
  [string]$Label,
  [string]$Protocol,
  [string]$NetworkMode,
  [string[]]$ExtraAllowedHosts,
  [int]$ContextTokens,
  [bool]$Thinking
) {
  $gatewayHost = Get-HostFromUrl $GatewayUrl
  $allowedHosts = @($gatewayHost)
  if ($HealthUrl -and $HealthUrl.Trim().Length -gt 0) {
    $healthHost = Get-HostFromUrl $HealthUrl
    if ($allowedHosts -notcontains $healthHost) {
      $allowedHosts += $healthHost
    }
  }
  foreach ($hostName in $ExtraAllowedHosts) {
    $cleanHost = "$hostName".Trim().ToLowerInvariant()
    if ($cleanHost.Length -gt 0 -and $allowedHosts -notcontains $cleanHost) {
      $allowedHosts += $cleanHost
    }
  }

  $maxBytes = $ContextTokens * 4
  $config = [ordered]@{
    modelAlias = $Model
    models = @(
      [ordered]@{
        id = $Model
        label = $Label
        description = "Configured by configure-gateway.ps1."
        thinking = [bool]$Thinking
        reasoningContentMode = "visible-when-no-content"
        contextTokens = $ContextTokens
      }
    )
    networkMode = $NetworkMode
    allowedHosts = $allowedHosts
    lab = [ordered]@{
      gatewayProtocol = $Protocol
      gatewayUrl = $GatewayUrl
    }
    context = [ordered]@{
      maxMessages = 100000
      maxTokens = $ContextTokens
      maxBytes = $maxBytes
      resumeMaxMessages = 100000
      resumeMaxTokens = $ContextTokens
      resumeMaxBytes = $maxBytes
      keepRecentMessages = 8
      tailTurns = 2
      preserveRecentTokens = 8000
      summaryBytes = 8192
    }
    agents = [ordered]@{
      modelTiers = [ordered]@{
        cheap = $Model
        default = $Model
        strong = $Model
      }
    }
  }

  if ($HealthUrl -and $HealthUrl.Trim().Length -gt 0) {
    $config.lab.gatewayHealthUrl = $HealthUrl
  }
  return $config
}

function Assert-Equal($Actual, $Expected, [string]$Name) {
  if ($Actual -ne $Expected) {
    throw "SelfTest failed: $Name expected '$Expected' but got '$Actual'"
  }
}

if ($SelfTest) {
  $testConfig = New-AntCodeGatewayConfig `
    -GatewayUrl "https://gateway.example.com/v1/chat/completions" `
    -HealthUrl "https://health.example.com/health" `
    -Model "demo-model" `
    -Label "Demo Model" `
    -Protocol "openai-chat" `
    -NetworkMode "approved-web" `
    -ExtraAllowedHosts @("duckduckgo.com", "github.com") `
    -ContextTokens 123456 `
    -Thinking $true
  Assert-Equal $testConfig.modelAlias "demo-model" "modelAlias"
  Assert-Equal $testConfig.models[0].id "demo-model" "models[0].id"
  Assert-Equal $testConfig.models[0].thinking $true "models[0].thinking"
  Assert-Equal $testConfig.context.maxTokens 123456 "context.maxTokens"
  Assert-Equal $testConfig.context.maxBytes 493824 "context.maxBytes"
  Assert-Equal $testConfig.networkMode "approved-web" "networkMode"
  Assert-Equal $testConfig.lab.gatewayProtocol "openai-chat" "lab.gatewayProtocol"
  Assert-Equal $testConfig.agents.modelTiers.cheap "demo-model" "agents.modelTiers.cheap"
  Assert-Equal $testConfig.agents.modelTiers.default "demo-model" "agents.modelTiers.default"
  Assert-Equal $testConfig.agents.modelTiers.strong "demo-model" "agents.modelTiers.strong"
  foreach ($expectedHost in @("gateway.example.com", "health.example.com", "duckduckgo.com", "github.com")) {
    if ($testConfig.allowedHosts -notcontains $expectedHost) {
      throw "SelfTest failed: allowedHosts did not include $expectedHost"
    }
  }
  Write-Host "configure-gateway.ps1 SelfTest passed."
  exit 0
}

if (-not $ConfigPath -or $ConfigPath.Trim().Length -eq 0) {
  $ConfigPath = Join-Path $env:USERPROFILE ".ant-code\lab-agent.config.json"
}

Write-Host ""
Write-Host "Ant Code gateway setup" -ForegroundColor Cyan
Write-Host "Config file: $ConfigPath"
Write-Host ""

$Protocol = Read-Optional "Gateway protocol: openai-chat or lab-agent-gateway" $Protocol
if ($Protocol -notin @("openai-chat", "lab-agent-gateway")) {
  throw "Unsupported gateway protocol: $Protocol"
}

$NetworkMode = Read-Optional "Network mode: approved-web allows web_search/web_fetch; lab-only blocks public web" $NetworkMode
if ($NetworkMode -notin @("offline", "lab-only", "approved-web", "open-dev")) {
  throw "Unsupported network mode: $NetworkMode"
}

$GatewayUrl = Read-Required "Gateway Chat URL, e.g. https://gateway.example.com/v1/chat/completions" $GatewayUrl
$HealthUrl = Read-Optional "Gateway health URL, optional" $HealthUrl
$Model = Read-Required "Model id or alias, e.g. example-vision-model" $Model
$Label = Read-Optional "Display label" $(if ($Label) { $Label } else { $Model })

$contextInput = Read-Optional "Context token limit" "$ContextTokens"
$ContextTokens = [int]$contextInput
if ($ContextTokens -lt 1000) {
  throw "Context token limit is too small: $ContextTokens"
}

if (-not $ApiKey -or $ApiKey.Trim().Length -eq 0) {
  Write-Host "Enter the gateway access token. Input will be hidden." -ForegroundColor Yellow
}
$ApiKey = Read-Secret "Gateway token" $ApiKey

$defaultWebHosts = @(
  "duckduckgo.com",
  "html.duckduckgo.com",
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "r.jina.ai"
)
$webHosts = @()
if ($NetworkMode -eq "approved-web" -or $NetworkMode -eq "open-dev") {
  $webHosts = $defaultWebHosts
}
if ($ExtraAllowedHosts -and $ExtraAllowedHosts.Count -gt 0) {
  $webHosts += $ExtraAllowedHosts
}

$config = New-AntCodeGatewayConfig `
  -GatewayUrl $GatewayUrl `
  -HealthUrl $HealthUrl `
  -Model $Model `
  -Label $Label `
  -Protocol $Protocol `
  -NetworkMode $NetworkMode `
  -ExtraAllowedHosts $webHosts `
  -ContextTokens $ContextTokens `
  -Thinking ([bool]$Thinking)

$configDir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

if (-not $NoEnvWrite) {
  [Environment]::SetEnvironmentVariable("LAB_AGENT_CONFIG", $ConfigPath, "User")
  [Environment]::SetEnvironmentVariable("LAB_MODEL_GATEWAY_API_KEY", $ApiKey, "User")
  $env:LAB_AGENT_CONFIG = $ConfigPath
  $env:LAB_MODEL_GATEWAY_API_KEY = $ApiKey
}

Write-Host ""
Write-Host "Wrote config file: $ConfigPath" -ForegroundColor Green
if ($NoEnvWrite) {
  Write-Host "Skipped user environment variable writes because -NoEnvWrite was set." -ForegroundColor Yellow
} else {
  Write-Host "Set user environment variables: LAB_AGENT_CONFIG, LAB_MODEL_GATEWAY_API_KEY" -ForegroundColor Green
  Write-Host "Open a new terminal to use this configuration automatically."
}

if (-not $NoVerify) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $exe = Join-Path $scriptDir "ant-code.exe"
  $cmd = Join-Path $scriptDir "ant-code.cmd"
  if (Test-Path $exe) {
    Write-Host ""
    Write-Host "Running ant-code doctor..." -ForegroundColor Cyan
    & $exe doctor
  } elseif (Test-Path $cmd) {
    Write-Host ""
    Write-Host "Running ant-code doctor..." -ForegroundColor Cyan
    & $cmd doctor
  } else {
    Write-Host ""
    Write-Host "ant-code.exe was not found next to this script. Open a new terminal and run: ant-code doctor" -ForegroundColor Yellow
  }
}
