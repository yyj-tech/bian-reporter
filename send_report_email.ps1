param(
    [string]$From = $env:REPORT_SMTP_FROM,
    [string]$To = $env:REPORT_SMTP_TO,
    [string]$SmtpPassword = $env:REPORT_SMTP_PASSWORD,
    [string]$Subject = "Binance Total Asset Report",
    [string]$BodyPath = ".\binance_asset_report_zh.md",
    [string]$SmtpServer = $(if ($env:REPORT_SMTP_SERVER) { $env:REPORT_SMTP_SERVER } else { "smtp.163.com" }),
    [int]$Port = $(if ($env:REPORT_SMTP_PORT) { [int]$env:REPORT_SMTP_PORT } else { 25 }),
    [bool]$EnableSsl = $(if ($env:REPORT_SMTP_ENABLE_SSL) { [System.Convert]::ToBoolean($env:REPORT_SMTP_ENABLE_SSL) } else { $true })
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-ConfigValue {
    param([string]$Name)

    $value = $null
    $envFilePath = Join-Path $PSScriptRoot ".env.local"
    if (Test-Path -LiteralPath $envFilePath) {
        foreach ($line in Get-Content -Path $envFilePath -Encoding ascii) {
            if (-not $line -or $line.TrimStart().StartsWith("#")) { continue }
            $separatorIndex = $line.IndexOf("=")
            if ($separatorIndex -le 0) { continue }
            $key = $line.Substring(0, $separatorIndex).Trim()
            if ($key -eq $Name) {
                $value = $line.Substring($separatorIndex + 1)
                break
            }
        }
    }
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    }
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Machine")
    }

    return $value
}

function ConvertFrom-MarkdownToHtml {
    param([string]$Markdown)

    $html = New-Object System.Collections.Generic.List[string]
    $html.Add("<!doctype html>")
    $html.Add("<html>")
    $html.Add("<head>")
    $html.Add("<meta charset=`"utf-8`">")
    $html.Add("<style>")
    $html.Add("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;color:#111827;line-height:1.55;margin:0;padding:24px;background:#f8fafc;}")
    $html.Add(".wrap{max-width:1080px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;}")
    $html.Add("h1{font-size:24px;margin:0 0 18px;color:#0f172a;}")
    $html.Add("h2{font-size:18px;margin:28px 0 12px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:6px;}")
    $html.Add("p{margin:8px 0;}")
    $html.Add("ul{margin:8px 0 16px 22px;padding:0;}")
    $html.Add("li{margin:4px 0;}")
    $html.Add("table{border-collapse:collapse;width:100%;margin:12px 0 22px;font-size:13px;}")
    $html.Add("th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:right;white-space:nowrap;}")
    $html.Add("th:first-child,td:first-child{text-align:left;}")
    $html.Add("th{background:#f3f4f6;color:#111827;font-weight:600;}")
    $html.Add("tr:nth-child(even) td{background:#fafafa;}")
    $html.Add("code{font-family:Consolas,monospace;background:#f3f4f6;padding:1px 4px;border-radius:4px;}")
    $html.Add(".muted{color:#6b7280;font-size:12px;margin-top:24px;}")
    $html.Add("</style>")
    $html.Add("</head>")
    $html.Add("<body><div class=`"wrap`">")

    $lines = $Markdown -split "`r?`n"
    $inList = $false
    $inTable = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $trimmed = $line.Trim()

        if (-not $trimmed) {
            if ($inList) {
                $html.Add("</ul>")
                $inList = $false
            }
            if ($inTable) {
                $html.Add("</tbody></table>")
                $inTable = $false
            }
            continue
        }

        if ($trimmed.StartsWith("|") -and $trimmed.EndsWith("|")) {
            $cells = @($trimmed.Trim("|").Split("|") | ForEach-Object { [System.Net.WebUtility]::HtmlEncode($_.Trim()) })
            $isSeparator = $true
            foreach ($cell in $cells) {
                if ($cell -notmatch "^:?-+:?$") {
                    $isSeparator = $false
                    break
                }
            }
            if ($isSeparator) { continue }

            if ($inList) {
                $html.Add("</ul>")
                $inList = $false
            }
            if (-not $inTable) {
                $html.Add("<table>")
                $html.Add("<thead>")
                $html.Add("<tr>" + (($cells | ForEach-Object { "<th>$_</th>" }) -join "") + "</tr>")
                $html.Add("</thead>")
                $html.Add("<tbody>")
                $inTable = $true
            }
            else {
                $html.Add("<tr>" + (($cells | ForEach-Object { "<td>$_</td>" }) -join "") + "</tr>")
            }
            continue
        }

        if ($inTable) {
            $html.Add("</tbody></table>")
            $inTable = $false
        }

        if ($trimmed.StartsWith("# ")) {
            if ($inList) { $html.Add("</ul>"); $inList = $false }
            $html.Add("<h1>$([System.Net.WebUtility]::HtmlEncode($trimmed.Substring(2)))</h1>")
            continue
        }

        if ($trimmed.StartsWith("## ")) {
            if ($inList) { $html.Add("</ul>"); $inList = $false }
            $html.Add("<h2>$([System.Net.WebUtility]::HtmlEncode($trimmed.Substring(3)))</h2>")
            continue
        }

        if ($trimmed.StartsWith("- ")) {
            if (-not $inList) {
                $html.Add("<ul>")
                $inList = $true
            }
            $html.Add("<li>$([System.Net.WebUtility]::HtmlEncode($trimmed.Substring(2)))</li>")
            continue
        }

        if ($inList) {
            $html.Add("</ul>")
            $inList = $false
        }
        $html.Add("<p>$([System.Net.WebUtility]::HtmlEncode($trimmed))</p>")
    }

    if ($inList) { $html.Add("</ul>") }
    if ($inTable) { $html.Add("</tbody></table>") }

    $html.Add("<p class=`"muted`">Markdown report is attached for archival use.</p>")
    $html.Add("</div></body></html>")
    return [string]::Join("`r`n", $html)
}

if (-not $From) {
    $From = Get-ConfigValue -Name "REPORT_SMTP_FROM"
}
if (-not $To) {
    $To = Get-ConfigValue -Name "REPORT_SMTP_TO"
}
if (-not $SmtpPassword) {
    $SmtpPassword = Get-ConfigValue -Name "REPORT_SMTP_PASSWORD"
}
$configuredSmtpServer = Get-ConfigValue -Name "REPORT_SMTP_SERVER"
if ($configuredSmtpServer) {
    $SmtpServer = $configuredSmtpServer
}
$configuredSmtpPort = Get-ConfigValue -Name "REPORT_SMTP_PORT"
if ($configuredSmtpPort) {
    $Port = [int]$configuredSmtpPort
}
$configuredEnableSsl = Get-ConfigValue -Name "REPORT_SMTP_ENABLE_SSL"
if ($configuredEnableSsl) {
    $EnableSsl = [System.Convert]::ToBoolean($configuredEnableSsl)
}

if (-not (Test-Path -LiteralPath $BodyPath)) {
    throw "Body file not found: $BodyPath"
}
if (-not $From) {
    throw "Missing sender. Pass -From or set REPORT_SMTP_FROM."
}
if (-not $To) {
    throw "Missing recipients. Pass -To or set REPORT_SMTP_TO with comma/semicolon separated addresses."
}
if (-not $SmtpPassword) {
    throw "Missing SMTP password. Pass -SmtpPassword or set REPORT_SMTP_PASSWORD."
}

$recipients = @($To -split "[,;]" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($recipients.Count -eq 0) {
    throw "No valid recipients found in To."
}

$body = Get-Content -Raw -Encoding utf8 $BodyPath
$htmlBody = ConvertFrom-MarkdownToHtml -Markdown $body

$message = [System.Net.Mail.MailMessage]::new()
$attachment = $null
$smtp = $null

try {
    $message.From = $From
    foreach ($recipient in $recipients) {
        $message.To.Add($recipient)
    }
    $message.Subject = $Subject
    $message.Body = $htmlBody
    $message.IsBodyHtml = $true
    $message.BodyEncoding = [System.Text.Encoding]::UTF8
    $message.SubjectEncoding = [System.Text.Encoding]::UTF8
    $message.HeadersEncoding = [System.Text.Encoding]::UTF8

    $attachment = [System.Net.Mail.Attachment]::new($BodyPath, "text/markdown; charset=utf-8")
    $attachment.NameEncoding = [System.Text.Encoding]::UTF8
    $message.Attachments.Add($attachment)

    $smtp = [System.Net.Mail.SmtpClient]::new($SmtpServer, $Port)
    $smtp.EnableSsl = $EnableSsl
    $smtp.Credentials = [System.Net.NetworkCredential]::new($From, $SmtpPassword)

    $smtp.Send($message)
    Write-Output "Email sent to $([string]::Join(', ', $recipients))."
}
catch {
    Write-Output $_.Exception.ToString()
    if ($_.Exception.InnerException) {
        Write-Output "INNER:"
        Write-Output $_.Exception.InnerException.ToString()
    }
    throw
}
finally {
    if ($attachment) { $attachment.Dispose() }
    $message.Dispose()
    if ($smtp) { $smtp.Dispose() }
}
