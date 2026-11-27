Attribute VB_Name = "WellSky_Import_"
Option Explicit
'**************************************************************************
' WellSky -> Therapy Schedule
' Fills the 1st Med, 2nd Med and AMU-Psych tgt from the WellSky Rehab
' Census tab in WorkWithPriends ("Copy for Schedule" button, or the file).
'
' Only these columns are written:  A  C  F  G  H  I  J  K  M  N  P
' Cell formatting is never changed. Rooms are matched on column B.
' At the end, rows whose room has nobody on the WellSky census (discharged,
' or added by mistake) are cleared in A and C:P. Column B and formulas stay.
' Rows whose column D says DIALYSIS ROOM are never touched.
' With "Same patient in room: only fill blanks" ticked in the Census tab, a row
' that already has the same patient only gets its empty cells filled.
'
' After a clean update it undoes last run's Team sheet layout, runs
' Run_All_Macros (which clears and refills Team 1-3 in place), then lays out the Team 1-3
' sheets: Precautions/Diagnosis split into D:E, each patient on two half-height
' rows, and a second line with Vitals (D) and CRIT labs (E) from WellSky.
'**************************************************************************

Private Const TAG As String = "#WELLSKY-SCHEDULE"
Private Const MAX_ROW As Long = 200
Private Const TEAM_SHEETS As String = "Team 1,Team 2,Team 3"
Private Const LAST_TEAM_COL As Long = 17          ' Q, after the new column E
Private layoutError As String

Public Sub UpdateFromWellSky()
    Dim txt As String, lines() As String, hdr() As String, f() As String
    Dim data As Object, rec As Object, seen As Object
    Dim i As Long, j As Long, r As Long, s As Long
    Dim tgt As Variant, ws As Worksheet
    Dim fn As Variant, msg As String, errMsg As String
    Dim wasProtected(0 To 2) As Boolean
    Dim key As String, curName As String
    Dim noRoom As String, notOnSheet As String, changedList As String, vacatedList As String
    Dim toReplace As Collection, toVacate As Collection, item As Variant
    Dim updated As Long, cleared As Long, filled As Long
    Dim fillBlanks As Boolean, blankOnly As Boolean, finishMsg As String

    '--- 1. Get the export (clipboard first, then ask for the file) ---
    txt = ClipboardText()
    If Left$(txt, Len(TAG)) <> TAG Then
        fn = Application.GetOpenFilename("WellSky schedule export (*.txt;*.tsv),*.txt;*.tsv", , _
             "Pick the schedule file from the WorkWithPriends Census tab")
        If VarType(fn) = vbBoolean Then Exit Sub
        txt = ReadUtf8(CStr(fn))
        If Left$(txt, Len(TAG)) <> TAG Then
            MsgBox "That doesn't look like a WellSky schedule export." & vbLf & _
                   "In the WorkWithPriends Census tab click 'Copy for Schedule' and run this again.", vbExclamation
            Exit Sub
        End If
    End If

    '--- 2. Parse it: one record per room ---
    txt = Replace(txt, vbCrLf, vbLf)
    lines = Split(txt, vbLf)
    If UBound(lines) < 1 Then Exit Sub
    fillBlanks = InStr(lines(0), vbTab & "fillBlanks=1") > 0
    hdr = Split(lines(1), vbTab)
    Set data = CreateObject("Scripting.Dictionary")
    Set seen = CreateObject("Scripting.Dictionary")
    For i = 2 To UBound(lines)
        If Len(Trim$(lines(i))) > 0 Then
            f = Split(lines(i), vbTab)
            Set rec = CreateObject("Scripting.Dictionary")
            For j = 0 To UBound(hdr)
                If j <= UBound(f) Then rec(hdr(j)) = Unescape(f(j)) Else rec(hdr(j)) = ""
            Next j
            If rec("room") = "" Then
                noRoom = noRoom & vbLf & "   " & rec("A")
            Else
                Set data(UCase$(rec("room"))) = rec
            End If
        End If
    Next i

    tgt = Array(shPatientRooms, sh2ndMed, shAMUPsych)

    '--- 3. First pass: rooms with a different patient now, and rooms nobody is in any more ---
    Set toReplace = New Collection
    Set toVacate = New Collection
    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        For r = 3 To MAX_ROW
            If UCase$(Trim$(ws.Cells(r, "B").Value & "")) = "RM#" Then Exit For
            key = RoomKey(ws.Cells(r, "B").Value & "")
            curName = Trim$(ws.Cells(r, "A").Value & "")
            If key <> "" And Not IsDialysisRow(ws, r) Then
                If curName <> "" Then filled = filled + 1
                If data.Exists(key) Then
                    seen(key) = True
                    If curName <> "" And NameKey(curName) <> NameKey(data(key)("A")) Then
                        changedList = changedList & vbLf & "   " & key & ":  " & OneLine(curName) & "  ->  " & data(key)("A")
                        toReplace.Add Array(s, r)
                    End If
                ElseIf RowHasText(ws, r) Then
                    vacatedList = vacatedList & vbLf & "   " & key & ":  " & IIf(curName = "", "(no name)", OneLine(curName))
                    toVacate.Add Array(s, r)
                End If
            End If
        Next r
    Next s

    ' Guard against the wrong facility's export wiping the sheets.
    If data.Count > 0 And seen.Count = 0 Then
        MsgBox "None of the rooms in this WellSky export are on the schedule sheets, so nothing was changed." & vbLf & _
               "Check the facility picked in the WorkWithPriends header and copy again.", vbExclamation, "WellSky update"
        Exit Sub
    End If
    If toVacate.Count > 5 And toVacate.Count * 2 > filled Then
        If MsgBox("WellSky has nobody in " & toVacate.Count & " of the " & filled & " filled rooms:" & vacatedList & vbLf & vbLf & _
                  "Clear them all?  (No = update everything else and leave these rows.)", _
                  vbYesNo + vbExclamation, "WellSky update") = vbNo Then
            Set toVacate = New Collection
            vacatedList = ""
        End If
    End If

    '--- 4. Write ---
    Application.ScreenUpdating = False
    Application.EnableEvents = False
    On Error GoTo CleanUp

    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        wasProtected(s) = ws.ProtectContents
        If wasProtected(s) Then ws.Unprotect
    Next s

    ' New patient in the room: clear the old one first so nothing carries over.
    For Each item In toReplace
        Set ws = tgt(item(0))
        ClearPatientRow ws, CLng(item(1))
    Next item

    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        For r = 3 To MAX_ROW
            If UCase$(Trim$(ws.Cells(r, "B").Value & "")) = "RM#" Then Exit For
            key = RoomKey(ws.Cells(r, "B").Value & "")
            If key <> "" And data.Exists(key) And Not IsDialysisRow(ws, r) Then
                Set rec = data(key)
                ' Same patient already in the room: only fill what's empty.
                curName = Trim$(ws.Cells(r, "A").Value & "")
                blankOnly = fillBlanks And curName <> "" And NameKey(curName) = NameKey(rec("A"))
                ApplyValue ws.Cells(r, "A"), rec("A"), blankOnly
                ApplyValue ws.Cells(r, "C"), rec("C"), blankOnly
                ApplyValue ws.Cells(r, "F"), rec("F"), blankOnly
                ApplyValue ws.Cells(r, "G"), rec("G"), blankOnly
                ApplyValue ws.Cells(r, "H"), rec("H"), blankOnly
                ApplyValue ws.Cells(r, "I"), rec("I"), blankOnly
                ApplyValue ws.Cells(r, "J"), rec("J"), blankOnly
                ApplyValue ws.Cells(r, "K"), rec("K"), blankOnly
                ApplyValue ws.Cells(r, "M"), rec("M"), blankOnly
                ApplyValue ws.Cells(r, "N"), rec("N"), blankOnly
                ApplyValue ws.Cells(r, "P"), rec("P"), blankOnly
                updated = updated + 1
            End If
        Next r
    Next s

    '--- 5. Cleanup: discharged (or wrongly added) patients ---
    For Each item In toVacate
        Set ws = tgt(item(0))
        ClearPatientRow ws, CLng(item(1))
        cleared = cleared + 1
    Next item

    For Each item In data.Keys
        If Not seen.Exists(item) Then notOnSheet = notOnSheet & vbLf & "   " & item & ":  " & data(item)("A")
    Next item

CleanUp:
    If Err.Number <> 0 Then errMsg = "Stopped on an error: " & Err.Description & vbLf & vbLf
    On Error Resume Next
    For s = 0 To UBound(tgt)
        If wasProtected(s) Then tgt(s).Protect
    Next s
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    On Error GoTo 0

    If errMsg = "" Then finishMsg = FinishSchedule(data)

    msg = errMsg & "Updated " & updated & " patient row(s)." & finishMsg
    If changedList <> "" Then msg = msg & vbLf & vbLf & "New patient in these rooms:" & changedList
    If cleared > 0 Then msg = msg & vbLf & vbLf & "Cleared (not on the WellSky census):" & vacatedList
    If notOnSheet <> "" Then msg = msg & vbLf & vbLf & "Room not found on the schedule:" & notOnSheet
    If noRoom <> "" Then msg = msg & vbLf & vbLf & "No room assigned in WellSky:" & noRoom
    MsgBox msg, IIf(errMsg = "", vbInformation, vbExclamation), "WellSky update"
End Sub

'--- after the update: the workbook's own macros, then the Team sheet layout ---
Private Function FinishSchedule(data As Object) As String
    Dim sheetList As Variant, i As Long, ws As Worksheet, out As String, n As Long

    ' Run_All_Macros clears and refills the Team sheets in place, so last run's extra
    ' column and rows have to go first or its rows would land one column off.
    sheetList = Split(TEAM_SHEETS, ",")
    For i = 0 To UBound(sheetList)
        Set ws = Nothing
        On Error Resume Next
        Set ws = ThisWorkbook.Worksheets(sheetList(i))
        On Error GoTo 0
        If Not ws Is Nothing Then
            If Not UndoTeamLayout(ws) Then
                FinishSchedule = vbLf & vbLf & "Couldn't undo the old layout on " & sheetList(i) & ": " & layoutError & _
                                 vbLf & "Run_All_Macros was not run."
                Exit Function
            End If
        End If
    Next i

    On Error Resume Next
    Application.Run "'" & ThisWorkbook.Name & "'!Run_All_Macros"
    If Err.Number <> 0 Then
        FinishSchedule = vbLf & vbLf & "Run_All_Macros stopped: " & Err.Description & vbLf & "Team sheets were not laid out."
        Err.Clear
        Exit Function
    End If
    On Error GoTo 0

    For i = 0 To UBound(sheetList)
        Set ws = Nothing
        On Error Resume Next
        Set ws = ThisWorkbook.Worksheets(sheetList(i))
        On Error GoTo 0
        If ws Is Nothing Then
            out = out & vbLf & "   " & sheetList(i) & ": sheet not found"
        Else
            n = LayoutTeamSheet(ws, data)
            If n = -1 Then
                out = out & vbLf & "   " & sheetList(i) & ": already laid out, left as is"
            ElseIf n = -2 Then
                out = out & vbLf & "   " & sheetList(i) & ": stopped on an error: " & layoutError
            Else
                out = out & vbLf & "   " & sheetList(i) & ": " & n & " patient(s)"
            End If
        End If
    Next i
    FinishSchedule = vbLf & vbLf & "Ran Run_All_Macros. Team sheets:" & out
End Function

' Lays out one Team sheet. Returns the number of patient rows, -1 if it was laid out
' already (D:E of the header row merged), or -2 on an error (see layoutError).
' Patient rows are the rows with a name in A between the "Patient" header row and the
' next "Patient" row.
Private Function LayoutTeamSheet(ws As Worksheet, data As Object) As Long
    Dim hdr As Long, endRow As Long, r As Long, k As Long, h As Double, w As Double
    Dim patRows As Collection, wasProtected As Boolean, rec As Object
    Dim alerts As Boolean

    For r = 1 To MAX_ROW
        If IsPatientHeader(ws, r) Then hdr = r: Exit For
    Next r
    If hdr = 0 Then Exit Function
    If ws.Cells(hdr, "D").MergeArea.Columns.Count > 1 Then LayoutTeamSheet = -1: Exit Function

    ' Patients end at the repeated "Patient" header; without one, at the first empty name.
    For r = hdr + 1 To MAX_ROW
        If IsPatientHeader(ws, r) Then endRow = r: Exit For
    Next r
    Set patRows = New Collection
    For r = hdr + 1 To IIf(endRow > 0, endRow - 1, MAX_ROW)
        If Len(Trim$(ws.Cells(r, "A").Value & "")) > 0 Then
            patRows.Add r
        ElseIf endRow = 0 And patRows.Count > 0 Then
            Exit For
        End If
    Next r

    alerts = Application.DisplayAlerts
    On Error GoTo Fail
    wasProtected = ws.ProtectContents
    If wasProtected Then ws.Unprotect
    Application.DisplayAlerts = False   ' merging asks before dropping empty cells

    ' Split D in two: new column E, each half the old width.
    w = ws.Columns("D").ColumnWidth
    ws.Columns("E").Insert Shift:=xlToRight, CopyOrigin:=xlFormatFromLeftOrAbove
    ws.Columns("D").ColumnWidth = w / 2
    ws.Columns("E").ColumnWidth = w / 2
    MergeDE ws, hdr

    ' Bottom-up so row numbers above stay put.
    For k = patRows.Count To 1 Step -1
        r = patRows(k)
        Set rec = FindPatient(data, ws.Cells(r, "B").Value & "", ws.Cells(r, "A").Value & "")
        h = ws.Rows(r).RowHeight
        ws.Rows(r + 1).Insert Shift:=xlDown, CopyOrigin:=xlFormatFromLeftOrAbove
        ws.Rows(r).RowHeight = h / 2
        ws.Rows(r + 1).RowHeight = h / 2
        MergeDE ws, r
        MergeDown ws, r
        WriteLabeled ws.Cells(r + 1, "D"), "Vitals", Field(rec, "vitals"), xlLeft
        WriteLabeled ws.Cells(r + 1, "E"), "CRIT", Field(rec, "crits"), xlRight
    Next k

    ' The row just past the last patient (the repeated header) gets D:E merged too.
    ' The last patient moved down one row for each patient above it, plus its own vitals row.
    If patRows.Count > 0 Then MergeDE ws, patRows(patRows.Count) + patRows.Count + 1

    Application.DisplayAlerts = alerts
    If wasProtected Then ws.Protect
    LayoutTeamSheet = patRows.Count
    Exit Function

Fail:
    layoutError = Err.Description
    Application.DisplayAlerts = alerts
    If wasProtected Then ws.Protect
    LayoutTeamSheet = -2
End Function

' Puts a Team sheet back the way Run_All_Macros expects it: removes each patient's
' second (vitals) row, restores the row height, and removes column E. Deleting whole
' rows and columns shrinks the merges with them. Does nothing if the sheet isn't laid out.
Private Function UndoTeamLayout(ws As Worksheet) As Boolean
    Dim hdr As Long, endRow As Long, r As Long, h As Double, w As Double
    Dim wasProtected As Boolean, alerts As Boolean

    For r = 1 To MAX_ROW
        If IsPatientHeader(ws, r) Then hdr = r: Exit For
    Next r
    UndoTeamLayout = True
    If hdr = 0 Then Exit Function
    If ws.Cells(hdr, "D").MergeArea.Columns.Count < 2 Then Exit Function

    alerts = Application.DisplayAlerts
    On Error GoTo Fail
    wasProtected = ws.ProtectContents
    If wasProtected Then ws.Unprotect
    Application.DisplayAlerts = False

    ' Only the patient rows: up to the repeated "Patient" header, or the first empty name.
    For r = hdr + 1 To hdr + 2 * MAX_ROW
        If IsPatientHeader(ws, r) Then Exit For
        If Len(Trim$(ws.Cells(r, "A").Value & "")) = 0 And Not ws.Cells(r, "A").MergeCells Then Exit For
    Next r
    endRow = r

    ' A vitals row is the lower half of a two-row merge in column A.
    For r = endRow - 1 To hdr + 2 Step -1
        If ws.Cells(r, "A").MergeArea.Row = r - 1 And ws.Cells(r, "A").MergeArea.Rows.Count = 2 Then
            h = ws.Rows(r - 1).RowHeight + ws.Rows(r).RowHeight
            ws.Rows(r).Delete
            ws.Rows(r - 1).RowHeight = h
        End If
    Next r

    w = ws.Columns("D").ColumnWidth + ws.Columns("E").ColumnWidth
    ws.Columns("E").Delete
    ws.Columns("D").ColumnWidth = w

    Application.DisplayAlerts = alerts
    If wasProtected Then ws.Protect
    Exit Function

Fail:
    layoutError = Err.Description
    Application.DisplayAlerts = alerts
    If wasProtected Then ws.Protect
    UndoTeamLayout = False
End Function

Private Function IsPatientHeader(ws As Worksheet, ByVal r As Long) As Boolean
    IsPatientHeader = StrComp(Trim$(ws.Cells(r, "A").Value & ""), "Patient", vbTextCompare) = 0
End Function

' D and E of one row become one cell, keeping D's text.
Private Sub MergeDE(ws As Worksheet, ByVal r As Long)
    With ws.Range(ws.Cells(r, "D"), ws.Cells(r, "E"))
        If Not .MergeCells Then .Merge
    End With
End Sub

' A, B, C and F through Q of row r merge with the new row below (D and E stay separate).
Private Sub MergeDown(ws As Worksheet, ByVal r As Long)
    Dim c As Long, m As Range, last As Long
    c = 1
    Do While c <= LAST_TEAM_COL
        If c = 4 Or c = 5 Then
            c = c + 1
        Else
            Set m = ws.Cells(r, c).MergeArea
            last = m.Column + m.Columns.Count - 1
            If last > LAST_TEAM_COL Then last = LAST_TEAM_COL
            ws.Range(ws.Cells(r, m.Column), ws.Cells(r + 1, last)).Merge
            c = last + 1
        End If
    Loop
End Sub

' "Vitals: BP:106/42, ..." with only the label in bold italics. Blank text leaves the cell empty.
Private Sub WriteLabeled(c As Range, ByVal label As String, ByVal text As String, ByVal align As Long)
    c.ClearContents
    c.HorizontalAlignment = align
    c.VerticalAlignment = xlCenter
    c.WrapText = False
    c.Font.Size = 9
    c.Font.Bold = False
    c.Font.Italic = False
    If text = "" Then Exit Sub
    c.Value = label & ": " & text
    With c.Characters(1, Len(label)).Font
        .Bold = True
        .Italic = True
    End With
End Sub

' The export row for a Team sheet row: by room, checked against the name; else by name.
Private Function FindPatient(data As Object, ByVal room As String, ByVal nm As String) As Object
    Dim key As Variant
    key = RoomKey(room)
    If data.Exists(key) Then
        If NameKey(data(key)("A")) = NameKey(nm) Then Set FindPatient = data(key): Exit Function
    End If
    For Each key In data.Keys
        If NameKey(data(key)("A")) = NameKey(nm) Then Set FindPatient = data(key): Exit Function
    Next key
End Function

Private Function Field(rec As Object, ByVal nm As String) As String
    If rec Is Nothing Then Exit Function
    If rec.Exists(nm) Then Field = rec(nm)
End Function

'--- write one cell according to the export's conventions ---
'   ""            leave the cell alone
'   {CLEAR}       clear it
'   {IFBLANK}x    write x only if the cell is empty
'   {LINE1}x      replace the first line, keep any later lines (Admit / D/C)
' blankOnly: only write into an empty cell, and never clear.
Private Sub ApplyValue(c As Range, ByVal v As String, Optional ByVal blankOnly As Boolean = False)
    Dim cur As String, p As Long
    If v = "" Then Exit Sub
    If blankOnly Then
        If Len(Trim$(c.Value & "")) > 0 Or v = "{CLEAR}" Then Exit Sub
        If Left$(v, 9) = "{IFBLANK}" Then v = Mid$(v, 10)
    End If
    If v = "{CLEAR}" Then
        c.ClearContents
    ElseIf Left$(v, 9) = "{IFBLANK}" Then
        If Len(Trim$(c.Value & "")) = 0 Then WriteText c, Mid$(v, 10)
    ElseIf Left$(v, 7) = "{LINE1}" Then
        cur = c.Value & ""
        p = InStr(cur, vbLf)
        If p > 0 Then WriteText c, Mid$(v, 8) & Mid$(cur, p) Else WriteText c, Mid$(v, 8) & vbLf
    Else
        WriteText c, v
    End If
End Sub

' Clears A and C:P on one row (column B and any formulas stay).
Private Sub ClearPatientRow(ws As Worksheet, ByVal r As Long)
    Dim c As Range
    For Each c In Union(ws.Cells(r, "A"), ws.Range(ws.Cells(r, "C"), ws.Cells(r, "P"))).Cells
        If c.MergeCells Then
            If c.Address = c.MergeArea.Cells(1, 1).Address And Not c.HasFormula Then c.MergeArea.ClearContents
        ElseIf Not c.HasFormula Then
            c.ClearContents
        End If
    Next c
End Sub

' The therapist marks dialysis-room rows in column D; those rows are left alone.
Private Function IsDialysisRow(ws As Worksheet, ByVal r As Long) As Boolean
    IsDialysisRow = InStr(1, ws.Cells(r, "D").Value & "", "DIALYSIS ROOM", vbTextCompare) > 0
End Function

' True if A or C:P has any typed-in text (formulas don't count).
Private Function RowHasText(ws As Worksheet, ByVal r As Long) As Boolean
    Dim c As Range
    For Each c In Union(ws.Cells(r, "A"), ws.Range(ws.Cells(r, "C"), ws.Cells(r, "P"))).Cells
        If Not c.HasFormula And Len(Trim$(c.Value & "")) > 0 Then RowHasText = True: Exit Function
    Next c
End Function

' Team stays a number; anything Excel would turn into a date/number stays text.
Private Sub WriteText(c As Range, ByVal v As String)
    If c.Column = 13 And IsNumeric(v) Then
        c.Value = CLng(v)
    ElseIf (IsDate(v) Or IsNumeric(v)) And c.NumberFormat <> "@" Then
        c.Value = "'" & v
    Else
        c.Value = v
    End If
End Sub

Private Function RoomKey(ByVal b As String) As String
    Dim p As Long
    b = Replace(b, vbCr, "")
    p = InStr(b, vbLf)
    If p > 0 Then b = Left$(b, p - 1)
    RoomKey = UCase$(Trim$(b))
End Function

' "Smith, John A (64M)" / "SMITH, JOHN" / "Smith, John "Jack"(64M)"  ->  "SMITH|JOHN"
Private Function NameKey(ByVal n As String) As String
    Dim p As Long, last As String, first As String
    p = InStr(n, "(")
    If p > 0 Then n = Left$(n, p - 1)
    n = UCase$(Trim$(Replace(Replace(n, """", " "), vbLf, " ")))
    p = InStr(n, ",")
    If p = 0 Then NameKey = n: Exit Function
    last = Trim$(Left$(n, p - 1))
    first = Trim$(Mid$(n, p + 1))
    p = InStr(first, " ")
    If p > 0 Then first = Left$(first, p - 1)
    NameKey = last & "|" & first
End Function

Private Function OneLine(ByVal s As String) As String
    OneLine = Replace(Replace(s, vbCr, ""), vbLf, " ")
End Function

Private Function Unescape(ByVal s As String) As String
    s = Replace(s, "\\", Chr$(1))
    s = Replace(s, "\n", vbLf)
    Unescape = Replace(s, Chr$(1), "\")
End Function

Private Function ClipboardText() As String
    On Error Resume Next
    With CreateObject("New:{1C3B4210-F441-11CE-B9EA-00AA006B1A69}")
        .GetFromClipboard
        ClipboardText = .GetText(1)
    End With
End Function

Private Function ReadUtf8(ByVal path As String) As String
    With CreateObject("ADODB.Stream")
        .Type = 2
        .Charset = "utf-8"
        .Open
        .LoadFromFile path
        ReadUtf8 = .ReadText
        .Close
    End With
    If Left$(ReadUtf8, 1) = ChrW$(&HFEFF) Then ReadUtf8 = Mid$(ReadUtf8, 2)
End Function
