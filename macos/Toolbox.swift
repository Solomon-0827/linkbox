import AppKit
import WebKit

private let ink = NSColor(calibratedRed: 0.122, green: 0.161, blue: 0.216, alpha: 1)
private let muted = NSColor(calibratedRed: 0.349, green: 0.396, blue: 0.475, alpha: 1)
private let accent = NSColor(calibratedRed: 0.145, green: 0.388, blue: 0.922, alpha: 1)
final class Canvas: NSView { override var isFlipped: Bool { true } }
final class SoftButton: NSButton {
    var primary = false
    var plain = false
    private var tracking:NSTrackingArea?
    private var hoverTimer:Timer?
    private var hover:CGFloat=0
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking=tracking { removeTrackingArea(tracking) }
        let area=NSTrackingArea(rect:.zero,options:[.mouseEnteredAndExited,.activeInKeyWindow,.inVisibleRect],owner:self,userInfo:nil)
        addTrackingArea(area);tracking=area
    }
    override func mouseEntered(with event:NSEvent) { animateHover(to:isEnabled ? 1 : 0) }
    override func mouseExited(with event:NSEvent) { animateHover(to:0) }
    private func animateHover(to target:CGFloat) {
        hoverTimer?.invalidate()
        let start=hover;let began=Date()
        hoverTimer=Timer.scheduledTimer(withTimeInterval:1/60,repeats:true) { [weak self] timer in
            guard let self=self else { timer.invalidate();return }
            let t=min(1,Date().timeIntervalSince(began)/0.14)
            self.hover=start+(target-start)*CGFloat(1-pow(1-t,3));self.needsDisplay=true
            if t>=1 { timer.invalidate() }
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        let amount=isEnabled ? hover : 0
        let base=primary ? accent : NSColor.white
        let target=primary ? NSColor(calibratedRed:0.10,green:0.29,blue:0.77,alpha:1) : NSColor(calibratedRed:0.92,green:0.95,blue:1,alpha:1)
        let fill=base.blended(withFraction:isHighlighted ? 0.85 : amount,of:target) ?? base
        (isEnabled ? (isHighlighted ? fill.withAlphaComponent(0.7) : fill) : fill.withAlphaComponent(0.35)).setFill()
        let path=NSBezierPath(roundedRect:bounds.insetBy(dx:isHighlighted ? 1.5 : 0.5,dy:isHighlighted ? 1.5 : 0.5),xRadius:5,yRadius:5)
        if !plain || amount>0 || isHighlighted { path.fill() }
        if !primary && !plain { NSColor(calibratedWhite:0.82,alpha:isEnabled ? 1 : 0.5).setStroke();path.lineWidth=1;path.stroke() }
        let color = primary ? NSColor.white.withAlphaComponent(isEnabled ? 1 : 0.5) : ink.withAlphaComponent(isEnabled ? 1 : 0.35)
        let attrs: [NSAttributedString.Key:Any] = [.font:NSFont.systemFont(ofSize:12,weight:.medium),.foregroundColor:color]
        let text = NSAttributedString(string:title,attributes:attrs)
        text.draw(at:NSPoint(x:(bounds.width-text.size().width)/2,y:(bounds.height-text.size().height)/2))
    }
}

final class SubscriptionPicker: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let panel = NSPanel(contentRect:NSRect(x:0,y:0,width:820,height:640),styleMask:[.titled],backing:.buffered,defer:false)
    let summary=NSTextField(labelWithString:"")
    let sourceTable=NSTableView()
    let sourceTitle=NSTextField(labelWithString:"")
    let scroll=NSScrollView()
    let document=Canvas(frame:.zero)
    var checks:[NSButton]=[]
    var groups:[String:[NSButton]]=[:]
    var sourceIDs:[String]=[]
    var sourceNames:[String:String]=[:]
    var nodeNames:[Int:String]=[:]
    var warnings:[String:String]=[:]
    var activeSource:String=""
    let fingerprint:String
    let onSave:([String:Any])->Void
    let onCancel:()->Void
    init(catalog:[String:Any],save:@escaping ([String:Any])->Void,cancel:@escaping ()->Void) {
        fingerprint=catalog["fingerprint"] as? String ?? "";onSave=save;onCancel=cancel
        super.init()
        panel.title="管理节点";panel.appearance=NSAppearance(named:.aqua)
        let view=Canvas(frame:NSRect(x:0,y:0,width:820,height:640));panel.contentView=view
        view.wantsLayer=true;view.layer?.backgroundColor=NSColor.white.cgColor
        func text(_ value:String,_ frame:NSRect,_ size:CGFloat=12,_ color:NSColor=muted) {
            let label=NSTextField(wrappingLabelWithString:value);label.frame=frame;label.font = .systemFont(ofSize:size);label.textColor=color;view.addSubview(label)
        }
        func button(_ title:String,_ action:Selector,_ frame:NSRect)->NSButton {
            let b=SoftButton(title:title,target:self,action:action);b.isBordered=false;b.frame=frame;view.addSubview(b);return b
        }
        text("选择加入列表的节点",NSRect(x:24,y:18,width:650,height:28),19,ink)
        text("左侧选择订阅，右侧勾选节点 · 保存后生效 · 当前入口自动保留",NSRect(x:24,y:52,width:770,height:22))
        _=button("全部选中",#selector(selectAll),NSRect(x:24,y:86,width:88,height:30))
        _=button("全部取消",#selector(clearAll),NSRect(x:122,y:86,width:88,height:30))
        summary.frame=NSRect(x:230,y:92,width:560,height:22);summary.font = .systemFont(ofSize:12);summary.textColor=muted;view.addSubview(summary)
        let sidebar=NSScrollView(frame:NSRect(x:24,y:130,width:194,height:438));sidebar.hasVerticalScroller=true;sidebar.autohidesScrollers=true;sidebar.borderType = .lineBorder
        sourceTable.addTableColumn(NSTableColumn(identifier:NSUserInterfaceItemIdentifier("subscription")));sourceTable.tableColumns[0].width=190
        sourceTable.headerView=nil;sourceTable.rowHeight=60;sourceTable.intercellSpacing=NSSize(width:0,height:0);sourceTable.dataSource=self;sourceTable.delegate=self;sourceTable.allowsEmptySelection=false;sourceTable.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        sourceTable.backgroundColor=NSColor(calibratedRed:0.96,green:0.97,blue:0.99,alpha:1);sidebar.documentView=sourceTable;view.addSubview(sidebar)
        sourceTitle.frame=NSRect(x:240,y:140,width:360,height:24);sourceTitle.font = .systemFont(ofSize:14,weight:.semibold);sourceTitle.textColor=ink;view.addSubview(sourceTitle)
        _=button("全选本组",#selector(selectGroup),NSRect(x:610,y:134,width:86,height:30))
        _=button("取消本组",#selector(clearGroup),NSRect(x:706,y:134,width:86,height:30))
        scroll.frame=NSRect(x:236,y:178,width:560,height:390);scroll.hasVerticalScroller=true;scroll.autohidesScrollers=true;scroll.borderType = .lineBorder
        document.frame=NSRect(x:0,y:0,width:538,height:390);scroll.documentView=document;view.addSubview(scroll)
        for source in catalog["sources"] as? [[String:Any]] ?? [] {
            guard let id=source["id"] as? String else { continue }
            sourceIDs.append(id);sourceNames[id]=source["name"] as? String ?? id;groups[id]=[];warnings[id]=source["warning"] as? String ?? ""
            for node in source["nodes"] as? [[String:Any]] ?? [] {
                guard let name=node["name"] as? String else { continue }
                let current=node["current"] as? Bool ?? false
                let b=NSButton(checkboxWithTitle:"",target:self,action:#selector(toggled(_:)));b.tag=checks.count
                b.state=(node["selected"] as? Bool ?? false) || current ? .on : .off;b.isEnabled = !current
                b.setAccessibilityLabel(name+(current ? "，当前入口，自动保留" : ""))
                checks.append(b);groups[id,default:[]].append(b);nodeNames[b.tag]=name
            }
        }
        _=button("取消",#selector(SubscriptionPicker.cancel),NSRect(x:596,y:590,width:90,height:32))
        let apply=button("保存选择",#selector(SubscriptionPicker.save),NSRect(x:698,y:590,width:98,height:32));(apply as? SoftButton)?.primary=true
        sourceTable.reloadData()
        if !sourceIDs.isEmpty { sourceTable.selectRowIndexes(IndexSet(integer:0),byExtendingSelection:false);activeSource=sourceIDs[0] }
        renderSource();updateCounts()
    }
    func numberOfRows(in tableView:NSTableView)->Int { sourceIDs.count }
    func tableView(_ tableView:NSTableView,viewFor tableColumn:NSTableColumn?,row:Int)->NSView? {
        let id=sourceIDs[row],items=groups[id] ?? []
        let cell=Canvas(frame:NSRect(x:0,y:0,width:190,height:60))
        let name=NSTextField(wrappingLabelWithString:sourceNames[id] ?? id);name.frame=NSRect(x:12,y:8,width:166,height:24);name.font = .systemFont(ofSize:13,weight:.medium);name.textColor=ink;cell.addSubview(name)
        let count=NSTextField(labelWithString:"已选 \(items.filter{$0.state == .on}.count) / \(items.count)");count.frame=NSRect(x:12,y:35,width:166,height:18);count.font = .systemFont(ofSize:11);count.textColor=muted;cell.addSubview(count)
        return cell
    }
    func tableViewSelectionDidChange(_ notification:Notification) {
        let row=sourceTable.selectedRow;guard row>=0,row<sourceIDs.count else { return }
        activeSource=sourceIDs[row];renderSource()
    }
    func renderSource() {
        for v in document.subviews { v.removeFromSuperview() }
        sourceTitle.stringValue=sourceNames[activeSource] ?? "暂无订阅"
        let items=groups[activeSource] ?? []
        var y:CGFloat=0
        for b in items {
            let value=(nodeNames[b.tag] ?? "")+(b.isEnabled ? "" : "  · 当前入口")
            let label=NSTextField(wrappingLabelWithString:value);label.font = .systemFont(ofSize:12);label.textColor=b.isEnabled ? ink : accent
            let measured=(value as NSString).boundingRect(with:NSSize(width:476,height:200),options:[.usesLineFragmentOrigin,.usesFontLeading],attributes:[.font:NSFont.systemFont(ofSize:12)])
            let height=max(CGFloat(40),ceil(measured.height)+20)
            b.frame=NSRect(x:12,y:y+(height-24)/2,width:22,height:24);document.addSubview(b)
            label.frame=NSRect(x:44,y:y+(height-ceil(measured.height))/2-1,width:476,height:ceil(measured.height)+3);document.addSubview(label)
            y+=height
        }
        if items.isEmpty {
            let value=sourceIDs.isEmpty ? "未发现订阅，请先在 Clash Verge 添加订阅。" : warnings[activeSource] ?? "暂无节点"
            let label=NSTextField(wrappingLabelWithString:value);label.frame=NSRect(x:18,y:24,width:500,height:60);label.font = .systemFont(ofSize:12);label.textColor=muted;document.addSubview(label)
        }
        document.setFrameSize(NSSize(width:538,height:max(y,390)))
        scroll.contentView.scroll(to:.zero);scroll.reflectScrolledClipView(scroll.contentView)
    }
    func updateCounts() {
        summary.stringValue="已选 \(checks.filter{$0.state == .on}.count) / \(checks.count) 个节点 · \(groups.count) 个订阅"
        sourceTable.reloadData(forRowIndexes:IndexSet(integersIn:0..<sourceIDs.count),columnIndexes:IndexSet(integer:0))
    }
    func set(_ items:[NSButton],_ state:NSControl.StateValue) { for b in items where b.isEnabled { b.state=state };updateCounts() }
    @objc func toggled(_ sender:NSButton) { updateCounts() }
    @objc func selectAll() { set(checks,.on) }
    @objc func clearAll() { set(checks,.off) }
    @objc func selectGroup() { set(groups[activeSource] ?? [],.on) }
    @objc func clearGroup() { set(groups[activeSource] ?? [],.off) }
    @objc func cancel() { onCancel() }
    @objc func save() {
        var selected=[String:[String]]()
        for id in sourceIDs { selected[id]=(groups[id] ?? []).filter{$0.state == .on}.compactMap{nodeNames[$0.tag]} }
        onSave(["fingerprint":fingerprint,"selected":selected])
    }
}

final class CenteredTextCell:NSTextFieldCell {
    override func drawingRect(forBounds rect:NSRect)->NSRect {
        var result=super.drawingRect(forBounds:rect)
        let height=cellSize(forBounds:rect).height
        result.origin.y+=(result.height-height)/2;result.size.height=height
        return result
    }
}
final class StatusPill:NSView {
    let text:String
    let color:NSColor
    init(_ text:String,_ color:NSColor) { self.text=text;self.color=color;super.init(frame:.zero);setAccessibilityElement(true);setAccessibilityRole(.staticText);setAccessibilityLabel(text) }
    required init?(coder:NSCoder) { fatalError() }
    override func draw(_ dirtyRect:NSRect) {
        color.withAlphaComponent(0.08).setFill();NSBezierPath(roundedRect:bounds,xRadius:10,yRadius:10).fill()
        let string=NSAttributedString(string:text,attributes:[.font:NSFont.systemFont(ofSize:11,weight:.medium),.foregroundColor:color])
        string.draw(at:NSPoint(x:(bounds.width-string.size().width)/2,y:(bounds.height-string.size().height)/2))
    }
}
final class ScoreGauge:NSProgressIndicator {
    override func draw(_ dirtyRect:NSRect) {
        NSColor(calibratedWhite:0.91,alpha:1).setFill();NSBezierPath(roundedRect:bounds,xRadius:3,yRadius:3).fill()
        NSColor(calibratedRed:0.13,green:0.72,blue:0.47,alpha:1).setFill()
        NSBezierPath(roundedRect:NSRect(x:0,y:0,width:bounds.width*max(0,min(100,doubleValue))/100,height:bounds.height),xRadius:3,yRadius:3).fill()
    }
}
final class LightRow:NSTableRowView {
    var currentNode=false
    private var hover:CGFloat=0
    private var hoverTimer:Timer?
    func animateHover(to target:CGFloat) {
        hoverTimer?.invalidate()
        let start=hover;let began=Date()
        hoverTimer=Timer.scheduledTimer(withTimeInterval:1/60,repeats:true) { [weak self] timer in
            guard let self=self else { timer.invalidate();return }
            let t=min(1,Date().timeIntervalSince(began)/0.14)
            self.hover=start+(target-start)*CGFloat(1-pow(1-t,3));self.needsDisplay=true
            if t>=1 { timer.invalidate() }
        }
    }
    override func drawBackground(in dirtyRect:NSRect) {
        let tint=NSColor(calibratedRed:0.94,green:0.96,blue:0.99,alpha:1)
        (NSColor.white.blended(withFraction:hover,of:tint) ?? .white).setFill();bounds.fill()
        if currentNode {
            accent.setFill();NSBezierPath(roundedRect:NSRect(x:0,y:(bounds.height-18)/2,width:3,height:18),xRadius:1.5,yRadius:1.5).fill()
        }
    }
    override var isEmphasized:Bool { get { false } set {} }
    override func drawSelection(in dirtyRect:NSRect) {}
}

final class HoverTable:NSTableView {
    private weak var hoveredRow:LightRow?
    private var pointerTimer:Timer?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow();pointerTimer?.invalidate();pointerTimer=nil
        guard window != nil else { return }
        let timer=Timer(timeInterval:0.05,repeats:true) { [weak self] _ in self?.updateHover() }
        RunLoop.main.add(timer,forMode:.common);pointerTimer=timer
    }
    private func updateHover() {
        var next:LightRow?
        if let window=window,window.isVisible,window.isKeyWindow {
            let point=convert(window.mouseLocationOutsideOfEventStream,from:nil)
            if visibleRect.contains(point) { let index=row(at:point);if index>=0 { next=rowView(atRow:index,makeIfNecessary:false) as? LightRow } }
        }
        if next !== hoveredRow { hoveredRow?.animateHover(to:0);hoveredRow=next;next?.animateHover(to:1) }
    }

}

final class AppDelegate: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    var window: NSWindow!
    var statusItem:NSStatusItem?
    let autoSwitch = NSSwitch()
    var autoTestsEnabled:Bool { UserDefaults.standard.object(forKey:"hourlyTestsEnabled") == nil || UserDefaults.standard.bool(forKey:"hourlyTestsEnabled") }
    var coffee: CoffeeReader?
    var generation = UUID()
    let identityType = NSTextField(labelWithString:"属性待验证")
    let locationLine = NSTextField(labelWithString:"")
    let providerLine = NSTextField(labelWithString:"")
    let identityLine = NSTextField(labelWithString:"正在查询出口…")
    let healthScore = NSTextField(labelWithString:"评分 · 检测中…")
    let updatedTime = NSTextField(labelWithString:"—")
    let scoreBar = ScoreGauge()
    let sourceLine = NSTextField(labelWithString:"")
    var coffeeIP = ""
    let ipSummary = NSTextField(labelWithString:"ipwho.is · 待查询")
    let ipDetails = NSTextField(labelWithString:"")
    let ipTime = NSTextField(labelWithString:"")
    let scoreValue = NSTextField(labelWithString:"—")
    let scoreDetail = NSTextField(labelWithString:"等待检测")
    let propertyValue = NSTextField(labelWithString:"—")
    let propertyDetail = NSTextField(labelWithString:"")
    let dnsValue = NSTextField(labelWithString:"DNS · 待检测")
    let udpValue = NSTextField(labelWithString:"UDP · 待检测")
    let leakDetail = NSTextField(labelWithString:"")
    let onlineStamp = NSTextField(labelWithString:"Net.Coffee · 第三方评估，并非 Claude 官方结论")
    let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ProxyToolbox")
    let entry = NSTextField(labelWithString: "正在读取…")
    let exitLabel = NSTextField(labelWithString: "—")
    let modeLabel = NSTextField(labelWithString: "—")
    let feedback = NSTextField(wrappingLabelWithString: "双击节点切换中转入口；测速不会自动切换。")
    let picker = NSPopUpButton(frame: .zero, pullsDown: false)
    let lastTestLabel = NSTextField(labelWithString:"上次测速：暂无记录")
    let spinner = NSProgressIndicator()
    let nodeTable = HoverTable()
    var nodeRows:[[String:Any]]=[]
    var latencyButton:NSButton!
    var chainButton:NSButton!
    var hourlyTestTimer:Timer?
    var chainTimer:Timer?
    var chainRunning=false

    var expectedIP = ""
    var current = ""
    var busy = false
    var controls: [NSControl] = []
    var nodePicker:SubscriptionPicker?
    var manageButton:NSButton!
    var updateButton: NSButton!
    var refreshButton: NSButton!
    var checkButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named:.aqua)
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let item = NSMenuItem(); menu.addItem(item)
        let submenu = NSMenu(); submenu.addItem(withTitle: "退出链路盒子", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = submenu; NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x:0,y:0,width:900,height:820), styleMask:[.titled,.closable,.miniaturizable,.fullSizeContentView], backing:.buffered,defer:false)
        window.title = "链路盒子"
        window.delegate=self
        window.acceptsMouseMovedEvents=true
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed:0.953,green:0.965,blue:0.980,alpha:1)
        window.appearance = NSAppearance(named:.aqua)
        window.center()
        let canvas = Canvas(frame:NSRect(x:0,y:0,width:900,height:820)); window.contentView = canvas
        func label(_ text:String,_ x:CGFloat,_ y:CGFloat,_ w:CGFloat,_ size:CGFloat=13,_ color:NSColor=muted,_ weight:NSFont.Weight = .regular) {
            let l=NSTextField(labelWithString:text); l.frame=NSRect(x:x,y:y,width:w,height:size+9); l.font = .systemFont(ofSize:size,weight:weight); l.textColor=color; canvas.addSubview(l)
        }
        func card(_ x:CGFloat,_ y:CGFloat,_ w:CGFloat,_ h:CGFloat,_ tint:NSColor = .white) {
            let v=NSView(frame:NSRect(x:x,y:y,width:w,height:h)); v.wantsLayer=true
            v.layer?.backgroundColor=tint.cgColor
            v.layer?.cornerRadius=16; v.layer?.borderWidth=1
            v.layer?.borderColor=NSColor(calibratedRed:0.82,green:0.85,blue:0.90,alpha:1).cgColor
            v.layer?.shadowColor=NSColor(calibratedRed:0.15,green:0.20,blue:0.30,alpha:1).cgColor
            v.layer?.shadowOpacity=0.06;v.layer?.shadowRadius=10;v.layer?.shadowOffset=NSSize(width:0,height:-3)
            canvas.addSubview(v)
        }
        func symbol(_ name:String,_ x:CGFloat,_ y:CGFloat,_ size:CGFloat,_ color:NSColor=accent) {
            let v=NSImageView(frame:NSRect(x:x,y:y,width:size,height:size)); v.image=NSImage(systemSymbolName:name,accessibilityDescription:nil); v.contentTintColor=color; v.imageScaling = .scaleProportionallyUpOrDown; canvas.addSubview(v)
        }
        func field(_ f:NSTextField,_ x:CGFloat,_ y:CGFloat,_ w:CGFloat,_ size:CGFloat,_ color:NSColor=ink) {
            f.frame=NSRect(x:x,y:y,width:w,height:20); f.font = .systemFont(ofSize:size,weight:.medium); f.textColor=color; f.lineBreakMode = .byTruncatingTail; canvas.addSubview(f)
        }
        // Geometry and visual hierarchy follow the selected Variant Final design.
        canvas.wantsLayer=true;canvas.layer?.backgroundColor=NSColor.white.cgColor
        func rule(_ x:CGFloat,_ y:CGFloat,_ w:CGFloat,_ h:CGFloat=1) {
            let v=NSView(frame:NSRect(x:x,y:y,width:w,height:h));v.wantsLayer=true;v.layer?.backgroundColor=NSColor(calibratedWhite:0.91,alpha:1).cgColor;canvas.addSubview(v)
        }
        symbol("shippingbox.fill",110,22,19,accent)
        label("Linkbox",137,22,130,13,ink,.semibold)
        latencyButton=button("轻量测速",#selector(testLatency));latencyButton.frame=NSRect(x:658,y:15,width:100,height:32);canvas.addSubview(latencyButton)
        chainButton=button("全链路测速",#selector(testChain));chainButton.frame=NSRect(x:770,y:15,width:106,height:32);canvas.addSubview(chainButton)
        (latencyButton as? SoftButton)?.primary=true
        rule(0,61,900)
        let overview=NSView(frame:NSRect(x:0,y:62,width:900,height:148));overview.wantsLayer=true;overview.layer?.backgroundColor=NSColor(calibratedRed:0.984,green:0.988,blue:0.992,alpha:1).cgColor;canvas.addSubview(overview)
        symbol("desktopcomputer",24,87,17,muted)
        label("本机",48,86,40,13,ink,.medium);symbol("chevron.right",94,90,10,muted)
        let pill=NSView(frame:NSRect(x:118,y:80,width:332,height:29));pill.wantsLayer=true;pill.layer?.backgroundColor=NSColor.white.cgColor;pill.layer?.cornerRadius=4;pill.layer?.borderWidth=1;pill.layer?.borderColor=NSColor(calibratedWhite:0.88,alpha:1).cgColor;canvas.addSubview(pill)
        label("●",127,87,12,10,.systemGreen)
        field(entry,145,87,295,12)
        symbol("chevron.right",464,90,10,muted);symbol("globe.americas.fill",489,86,18,accent);field(exitLabel,516,87,300,13)
        for x:CGFloat in [192,370,548,726] { rule(x,129,1,55) }
        label("出口 IP",24,128,150,11,muted,.medium)
        field(identityLine,24,147,143,14)
        let copy=button("⧉",#selector(copyExitIP));copy.frame=NSRect(x:164,y:145,width:22,height:24);(copy as? SoftButton)?.plain=true;copy.setAccessibilityLabel("复制出口 IP");canvas.addSubview(copy)
        field(identityType,24,171,160,10,muted)
        label("地区 / ISP",208,128,150,11,muted,.medium)
        field(locationLine,208,147,150,12);field(providerLine,208,169,150,10,muted);providerLine.maximumNumberOfLines=2;providerLine.usesSingleLineMode=false;providerLine.lineBreakMode = .byWordWrapping;providerLine.frame.size.height=33
        label("安全检测",386,128,150,11,muted,.medium)
        field(dnsValue,386,147,150,11);field(udpValue,386,165,150,11)
        label("WebKit · 第三方检测",386,186,150,9,muted)
        label("信任评分",564,128,146,11,muted,.medium)
        field(healthScore,564,147,146,14)
        scoreBar.frame=NSRect(x:564,y:174,width:118,height:5);scoreBar.style = .bar;scoreBar.isIndeterminate=false;scoreBar.minValue=0;scoreBar.maxValue=100;canvas.addSubview(scoreBar)
        label("更新时间",742,128,134,11,muted,.medium)
        field(updatedTime,742,147,134,14);field(sourceLine,742,171,134,10,muted)
        rule(0,209,900)
        let columns:[(String,String,CGFloat)] = [("rank","排名",50),("name","中转节点名称",392),("provider","来源订阅",100),("delay","入口延迟",100),("chain_delay","全链路延迟",110),("test_state","检测状态",100)]
        var columnX:CGFloat=24
        for (key,title,width) in columns {
            let l=NSTextField(labelWithString:title);l.frame=NSRect(x:columnX+6,y:224,width:width-14,height:18);l.font = .systemFont(ofSize:12,weight:.medium);l.textColor=muted
            if ["delay","chain_delay","test_state"].contains(key) { l.alignment = .right };canvas.addSubview(l)
            columnX += width
        }
        rule(0,250,900)
        let scroll=NSScrollView(frame:NSRect(x:24,y:251,width:852,height:459))
        scroll.hasVerticalScroller=true;scroll.scrollerStyle = .overlay;scroll.drawsBackground=true;scroll.backgroundColor = .white;scroll.borderType = .noBorder
        nodeTable.frame=NSRect(x:0,y:0,width:852,height:459);nodeTable.style = .plain;nodeTable.headerView=nil
        for (key,title,width) in columns {
            let column=NSTableColumn(identifier:NSUserInterfaceItemIdentifier(key));column.title=title;column.minWidth=width;column.maxWidth=width;column.width=width;nodeTable.addTableColumn(column)
        }
        nodeTable.columnAutoresizingStyle = .noColumnAutoresizing
        nodeTable.rowHeight=48;nodeTable.intercellSpacing=NSSize(width:0,height:1)
        nodeTable.backgroundColor = .white;nodeTable.usesAlternatingRowBackgroundColors=false
        nodeTable.gridStyleMask = .solidHorizontalGridLineMask;nodeTable.gridColor = NSColor(calibratedWhite:0.96,alpha:1)
        nodeTable.delegate=self;nodeTable.dataSource=self;nodeTable.allowsMultipleSelection=false
        nodeTable.target=self;nodeTable.doubleAction=#selector(doubleClickNode)
        scroll.documentView=nodeTable;canvas.addSubview(scroll)
        rule(0,710,900)
        spinner.frame=NSRect(x:326,y:790,width:12,height:12);spinner.style = .spinning;spinner.controlSize = .small;spinner.isDisplayedWhenStopped=false;canvas.addSubview(spinner)
        func toolbarText(_ text:NSTextField,_ x:CGFloat,_ width:CGFloat,_ size:CGFloat,_ centerY:CGFloat=740) {
            let value=text.stringValue;text.cell=CenteredTextCell(textCell:value);text.isBordered=false;text.isEditable=false;text.drawsBackground=false
            text.frame=NSRect(x:x,y:centerY-14,width:width,height:28);text.font = .systemFont(ofSize:size,weight:.medium);text.textColor=muted;canvas.addSubview(text)
        }
        toolbarText(NSTextField(labelWithString:"每小时测速"),72,94,12)
        rule(179,729,1,22)
        toolbarText(lastTestLabel,198,410,11);refreshLastTestTime()
        autoSwitch.setAccessibilityLabel("每小时自动测速");autoSwitch.frame=NSRect(x:24,y:727,width:38,height:26);autoSwitch.controlSize = .small;autoSwitch.state=autoTestsEnabled ? .on : .off;autoSwitch.target=self;autoSwitch.action=#selector(toggleAutoTests);canvas.addSubview(autoSwitch)
        let reportButton=button("检查报告",#selector(reports));reportButton.frame=NSRect(x:623,y:726,width:74,height:28);(reportButton as? SoftButton)?.plain=true;canvas.addSubview(reportButton)
        checkButton=button("检查网络",#selector(check));checkButton.frame=NSRect(x:701,y:726,width:74,height:28);(checkButton as? SoftButton)?.plain=true;canvas.addSubview(checkButton)
        let ipButton=button("Net.Coffee ↗",#selector(showIP));ipButton.frame=NSRect(x:781,y:726,width:95,height:28);canvas.addSubview(ipButton)
        rule(24,771,852)
        refreshButton=button("↻ 刷新状态",#selector(refresh));refreshButton.frame=NSRect(x:19,y:782,width:94,height:28);(refreshButton as? SoftButton)?.plain=true;canvas.addSubview(refreshButton)
        updateButton=button("↓ 更新订阅",#selector(updateSubscriptions));updateButton.frame=NSRect(x:119,y:782,width:94,height:28);(updateButton as? SoftButton)?.plain=true;canvas.addSubview(updateButton)
        manageButton=button("管理节点",#selector(manageNodes));manageButton.frame=NSRect(x:219,y:782,width:94,height:28);canvas.addSubview(manageButton)
        toolbarText(feedback,348,280,11,796)
        feedback.maximumNumberOfLines=2;feedback.usesSingleLineMode=false;feedback.lineBreakMode = .byWordWrapping
        toolbarText(modeLabel,638,238,11,796);modeLabel.alignment = .right
        controls = [picker,manageButton,updateButton,refreshButton,checkButton,latencyButton,chainButton]
        let tray=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength)
        tray.button?.image=NSImage(systemSymbolName:"link",accessibilityDescription:"链路盒子")
        let trayMenu=NSMenu()
        let openItem=NSMenuItem(title:"打开链路盒子",action:#selector(showWindow),keyEquivalent:"");openItem.target=self;trayMenu.addItem(openItem)
        trayMenu.addItem(.separator())
        let quitItem=NSMenuItem(title:"退出链路盒子",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"");quitItem.target=NSApp;trayMenu.addItem(quitItem)
        tray.menu=trayMenu;statusItem=tray
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        invoke(["status"],message:"正在读取 Clash 状态…") { _ in
            self.refreshOnline()
            if self.autoTestsEnabled { self.beginTest("chain") }
        }
        configureAutoTests()
    }
    func configureAutoTests() {
        hourlyTestTimer?.invalidate();hourlyTestTimer=nil
        guard autoTestsEnabled else { return }
        let timer=Timer(timeInterval:3600,repeats:true) { [weak self] _ in
            guard let self=self,self.autoTestsEnabled,!self.busy,self.nodePicker == nil else { return }
            self.invoke(["status"],message:"正在读取 Clash 状态…") { _ in
                if self.autoTestsEnabled { self.beginTest("chain") }
            }
        }
        hourlyTestTimer=timer;RunLoop.main.add(timer,forMode:.common)
    }
    @objc func toggleAutoTests() {
        UserDefaults.standard.set(autoSwitch.state == .on,forKey:"hourlyTestsEnabled")
        configureAutoTests()
    }
    @objc func copyExitIP() {
        let value=identityLine.stringValue
        guard value.split(separator:".").count == 4,value.allSatisfy({$0.isNumber || $0 == "."}) else { return }
        NSPasteboard.general.clearContents();NSPasteboard.general.setString(value,forType:.string)
        if !busy { feedback.stringValue="已复制出口 IP" }
    }
    func button(_ text: String,_ action: Selector) -> NSButton { let b = SoftButton(title:text,target:self,action:action); b.isBordered = false; b.setButtonType(.momentaryPushIn); return b }
    func setBusy(_ value: Bool,_ message: String) {
        if !value { chainTimer?.invalidate();chainTimer=nil;chainRunning=false;chainButton.title="全链路测速" }
        busy = value
        nodeTable.allowsEmptySelection = true
        nodeTable.allowsTypeSelect = !value
        for c in controls { c.isEnabled = !value }
        if value { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        feedback.stringValue = message == "状态已更新。没有修改代理配置。" ? "\(nodeRows.count) 个节点 · 双击切换中转" : message
    }
    func render(_ s: [String:Any]) {
        expectedIP = s["expected_ip"] as? String ?? ""
        refreshLastTestTime()
        current = s["entry"] as? String ?? ""
        entry.stringValue = current
        exitLabel.stringValue = s["exit"] as? String ?? "未知"
        modeLabel.stringValue = "●  \((s["mode"] as? String) == "global" ? "全局代理" : (s["mode"] as? String ?? "未知"))  ·  TUN \((s["tun"] as? Bool ?? false) ? "开启" : "关闭")"
        picker.removeAllItems(); picker.addItems(withTitles: s["nodes"] as? [String] ?? []); picker.selectItem(withTitle: current)
        nodeRows=s["node_rows"] as? [[String:Any]] ?? (s["nodes"] as? [String] ?? []).map{["name":$0,"status":"未验证"]}
        let sortKey=nodeRows.contains{ $0["chain_delay"] as? Double != nil } ? "chain_delay" : "delay"
        nodeRows.sort { a,b in
            let da=a[sortKey] as? Double ?? Double.greatestFiniteMagnitude,db=b[sortKey] as? Double ?? Double.greatestFiniteMagnitude
            return da == db ? (a["name"] as? String ?? "") < (b["name"] as? String ?? "") : da < db
        }
        nodeTable.reloadData()
        nodeTable.deselectAll(nil)
    }
    func showFastestNodes() {
        guard !nodeRows.isEmpty else { return }
        nodeTable.scrollRowToVisible(0)
        if let scroll=nodeTable.enclosingScrollView { let y=scroll.contentView.bounds.origin.y;scroll.contentView.scroll(to:NSPoint(x:0,y:y));scroll.reflectScrolledClipView(scroll.contentView) }
    }
    @objc func doubleClickNode() {
        let row=nodeTable.clickedRow
        guard !busy,row>=0,row<nodeRows.count,let name=nodeRows[row]["name"] as? String else { return }
        picker.selectItem(withTitle:name)
        switchNode()
    }
    func invoke(_ args: [String], message: String, input:Data? = nil, complete: @escaping ([String:Any]) -> Void) {
        guard !busy else { return }
        setBusy(true,message)
        let script = Bundle.main.resourceURL!.appendingPathComponent("backend/linkbox-backend").path
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: script); p.arguments = args
            let out = Pipe(); let err = Pipe(); p.standardOutput = out; p.standardError = err
            do {
                let stdin=Pipe();if input != nil { p.standardInput=stdin }
                try p.run()
                if let input=input { stdin.fileHandleForWriting.write(input);try? stdin.fileHandleForWriting.close() }
                let data = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
                let parsed = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
                DispatchQueue.main.async {
                    guard let result = parsed else { self.current = ""; self.setBusy(false,"操作未完成：未收到有效结果，请确认工具文件完整。"); return }
                    if result["ok"] as? Bool != true {
                        self.current = ""; self.setBusy(false,result["error"] as? String ?? "操作失败"); if args.first == "switch" { self.refreshOnline() }; return
                    }
                    if let state = result["state"] as? [String:Any] { self.render(state) }
                    self.setBusy(false,result["message"] as? String ?? "状态已更新。没有修改代理配置。")
                    if args.first == "chain" || args.first == "latency" || args.first == "status" { self.showFastestNodes() }
                    complete(result)
                }
            } catch {
                DispatchQueue.main.async { self.current = ""; self.setBusy(false,"无法启动工具：\(error.localizedDescription)") }
            }
        }
    }
    func tableView(_ tableView:NSTableView,rowViewForRow row:Int)->NSTableRowView? { let v=LightRow();v.currentNode=nodeRows[row]["name"] as? String == current;return v }
    func numberOfRows(in tableView:NSTableView)->Int { nodeRows.count }
    func tableView(_ tableView:NSTableView,shouldSelectRow row:Int)->Bool { false }
    func tableViewSelectionDidChange(_ notification:Notification) {
        let index=nodeTable.selectedRow
        if index>=0,index<nodeRows.count,let name=nodeRows[index]["name"] as? String { picker.selectItem(withTitle:name) }
    }
    func tableView(_ tableView:NSTableView,viewFor tableColumn:NSTableColumn?,row:Int)->NSView? {
        guard row<nodeRows.count,let key=tableColumn?.identifier.rawValue else{return nil}
        let item=nodeRows[row];let label=NSTextField(labelWithString:"");label.cell=CenteredTextCell(textCell:"");label.isBordered=false;label.isEditable=false;label.drawsBackground=false
        label.font = .systemFont(ofSize:13);label.textColor=ink;label.lineBreakMode = .byTruncatingTail
        switch key {
        case "rank":label.stringValue="\(row+1)";label.textColor=muted;label.font = .monospacedDigitSystemFont(ofSize:11,weight:.regular)
        case "name":
            let name=item["name"] as? String ?? "";label.stringValue=name
            if name==current { label.textColor=accent;label.setAccessibilityLabel(name + "，当前使用");label.font = .systemFont(ofSize:13,weight:.semibold) }
        case "delay":label.stringValue=(item["delay"] as? Int).map{"\($0) ms"} ?? "—";label.textColor = (item["delay"] as? Int) != nil ? ink : muted
        case "chain_delay":label.stringValue=(item[key] as? Int).map{"\($0) ms"} ?? "—";label.textColor = (item[key] as? Int) != nil ? ink : muted
        case "test_state":
            let state=item[key] as? String ?? ((item["chain_time"] as? String ?? item["time"] as? String ?? "").isEmpty ? "待检测" : "已完成")
            label.stringValue=state == "检测中" ? "◌ 检测中" : state == "已完成" ? "✓ 完成" : state == "已停止" ? "— 已停止" : "· 等待"
            label.font = .systemFont(ofSize:11,weight:.medium)
            label.textColor=state == "检测中" ? accent : state == "已完成" ? NSColor(calibratedRed:0.15,green:0.48,blue:0.35,alpha:1) : muted
        default:label.stringValue=item[key] as? String ?? "—"
        }
        if key == "delay" || key == "chain_delay" {
            label.alignment = .right
            label.font = .monospacedDigitSystemFont(ofSize:12,weight:key == "chain_delay" ? .semibold : .regular)
            if key == "delay" { label.textColor=muted }
        }
        let cell=NSTableCellView();cell.textField=label;cell.addSubview(label);label.translatesAutoresizingMaskIntoConstraints=false
        NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo:cell.leadingAnchor,constant:6),label.trailingAnchor.constraint(equalTo:cell.trailingAnchor,constant:-8),label.centerYAnchor.constraint(equalTo:cell.centerYAnchor),label.heightAnchor.constraint(equalToConstant:22)])
        if key == "test_state" {
            label.isHidden=true
            let pill=StatusPill(label.stringValue,label.textColor ?? muted);cell.addSubview(pill);pill.translatesAutoresizingMaskIntoConstraints=false
            NSLayoutConstraint.activate([pill.trailingAnchor.constraint(equalTo:cell.trailingAnchor,constant:-8),pill.widthAnchor.constraint(equalToConstant:78),pill.heightAnchor.constraint(equalToConstant:24),pill.centerYAnchor.constraint(equalTo:cell.centerYAnchor)])
        }
        return cell
    }
    func refreshLastTestTime() {
        var latest:(Date,String,Bool)?
        for (file,title) in [("chain-results.json","全链路"),("latency-results.json","入口")] {
            let url=base.appendingPathComponent(file)
            guard let data=try? Data(contentsOf:url),let record=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                  let results=record["results"] as? [String:Any],!results.isEmpty else { continue }
            let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            var date=(record["finished_at"] as? String).flatMap{parser.date(from:$0)}
            if date == nil { parser.formatOptions=[.withInternetDateTime];date=(record["finished_at"] as? String).flatMap{parser.date(from:$0)} }
            if date == nil { date=(try? url.resourceValues(forKeys:[.contentModificationDateKey]))?.contentModificationDate }
            guard let date=date else { continue }
            if latest == nil || date > latest!.0 { latest=(date,title,!(record["reason"] as? String ?? "").isEmpty) }
        }
        guard let (date,title,stopped)=latest else { lastTestLabel.stringValue="上次测速：暂无记录";return }
        let formatter=DateFormatter();formatter.dateFormat="MM-dd HH:mm:ss"
        lastTestLabel.stringValue="上次测速：\(formatter.string(from:date))  ·  \(title)\(stopped ? " · 已中止" : "")"
    }
    func readTestProgress(_ kind:String,finished:Bool=false) {
        guard let data=try? Data(contentsOf:base.appendingPathComponent("\(kind)-progress.json")),
              let p=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { return }
        let running=Set(p["running"] as? [String] ?? [])
        let results=p["results"] as? [String:[String:Any]] ?? [:]
        for i in nodeRows.indices {
            let name=nodeRows[i]["name"] as? String ?? ""
            if let row=results[name] {
                nodeRows[i].merge(row){ _,new in new };nodeRows[i]["test_state"]="已完成"
            } else {
                nodeRows[i]["test_state"]=finished ? "已停止" : running.contains(name) ? "检测中" : "待检测"
                nodeRows[i][kind == "chain" ? "chain_delay" : "delay"]=NSNull()
            }
        }
        nodeTable.reloadData()
        let count=p["index"] as? Int ?? 0,total=p["total"] as? Int ?? nodeRows.count
        if finished { refreshLastTestTime() }
        feedback.stringValue=finished ? (count == total ? "检测完成 · \(total) 个节点" : "检测已停止 · \(count) / \(total)") : "检测中 · \(count) / \(total)"
    }
    func beginTest(_ kind:String) {
        guard !busy else { return }
        try? FileManager.default.removeItem(at:base.appendingPathComponent("\(kind)-progress.json"))
        for i in nodeRows.indices {
            nodeRows[i]["test_state"]="待检测"
            nodeRows[i][kind == "chain" ? "chain_delay" : "delay"]=NSNull()
        }
        nodeTable.reloadData()
        chainRunning=kind == "chain"
        invoke([kind],message:"准备检测 · \(nodeRows.count) 个节点") { _ in self.readTestProgress(kind,finished:true);self.showFastestNodes() }
        if chainRunning { chainButton.title="停止测速";chainButton.isEnabled=true }
        chainTimer=Timer.scheduledTimer(withTimeInterval:0.25,repeats:true) { _ in self.readTestProgress(kind) }
    }
    @objc func testLatency() { beginTest("latency") }
    @objc func testChain() {
        if chainRunning {
            try? Data().write(to:base.appendingPathComponent("chain-cancel"))
            chainButton.isEnabled=false;return
        }
        beginTest("chain")
    }
    @objc func manageNodes() {
        invoke(["subscription-catalog"],message:"正在读取 Clash Verge 订阅…") { [weak self] result in
            guard let self=self else { return }
            guard let catalog=result["catalog"] as? [String:Any] else { return }
            let picker=SubscriptionPicker(catalog:catalog,save:{ [weak self] selection in
                guard let self=self,let picker=self.nodePicker,let data=try? JSONSerialization.data(withJSONObject:selection) else { return }
                self.window.endSheet(picker.panel);self.nodePicker=nil
                self.invoke(["save-node-selection"],message:"正在保存节点选择…",input:data) { _ in self.showFastestNodes() }
            },cancel:{ [weak self] in
                guard let self=self,let picker=self.nodePicker else { return }
                self.window.endSheet(picker.panel);self.nodePicker=nil
            })
            self.nodePicker=picker;self.window.beginSheet(picker.panel)
        }
    }
    @objc func updateSubscriptions() { invoke(["update-subscriptions"],message:"正在更新保留的订阅…") { _ in self.refreshOnline();self.showFastestNodes() } }
    @objc func refresh() { invoke(["status"],message:"正在读取 Clash 状态…") { _ in self.refreshOnline() } }
    @objc func check() { invoke(["check"],message:"正在检查；浏览器会打开结果页。不会改变代理或 Claude 任务。") { _ in } }
    @objc func switchNode() {
        guard !busy, let target = picker.titleOfSelectedItem, !current.isEmpty else { return }
        if target == current { feedback.stringValue = "已经是该节点，没有修改。"; return }
        resetOnline()
        invoke(["switch",target,current],message:"正在切换中转入口…") { _ in self.refreshOnline() }
    }

    @objc func showIP() { NSWorkspace.shared.open(URL(string:"https://ip.net.coffee/claude/")!) }
    func resetOnline() {
        generation = UUID(); coffee?.cancel(); coffee=nil
        ipSummary.stringValue="正在查询出口…"; ipDetails.stringValue=""; ipTime.stringValue="";locationLine.stringValue="";providerLine.stringValue=""
        scoreValue.stringValue="—";scoreDetail.stringValue="正在检测…";propertyValue.stringValue="—";propertyDetail.stringValue=""
        dnsValue.stringValue="DNS · 正在检测…";udpValue.stringValue="UDP · 正在检测…";leakDetail.stringValue=""
        coffeeIP=""
        onlineStamp.stringValue="Net.Coffee 检测中"
        renderOverview()
    }
    func refreshOnline() {
        resetOnline()
        let id=generation
        coffee=CoffeeReader(base:base) { [weak self] result,finished in
            guard let self=self,self.generation==id else { return }
            self.renderCoffee(result,finished:finished)
        }
        coffee?.start()
        DispatchQueue.global(qos:.userInitiated).async {
            let p=Process();p.executableURL=Bundle.main.resourceURL!.appendingPathComponent("backend/linkbox-backend");p.arguments=["ip-info"]
            let pipe=Pipe();p.standardOutput=pipe;p.standardError=FileHandle.nullDevice
            var data:[String:Any]=[:]
            do { try p.run();let bytes=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit();data=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] ?? [:] } catch { data=["error":error.localizedDescription] }
            let result=data
            DispatchQueue.main.async {
                guard self.generation==id else { return }
                guard result["ok"] as? Bool == true,let info=result["ip_info"] as? [String:Any] else {
                    self.ipSummary.stringValue="出口未验证";self.locationLine.stringValue=result["error"] as? String ?? "查询失败，请刷新重试";self.renderOverview();return
                }
                let address=info["ip"] as? String ?? "未知"
                
                let connection=info["connection"] as? [String:Any] ?? [:]
                self.ipSummary.stringValue=address
                self.locationLine.stringValue=[info["city"],info["country"]].compactMap{$0 as? String}.joined(separator:" · ").replacingOccurrences(of:"United States",with:"美国").replacingOccurrences(of:"Los Angeles",with:"洛杉矶")
                self.providerLine.stringValue="\(connection["isp"] as? String ?? "未知运营商") · AS\(connection["asn"] ?? "未知")"
                self.ipTime.stringValue="ipwho.is \(info["updated_at"] as? String ?? "")\(address == self.expectedIP ? "" : " · 出口不一致")"
                self.renderOverview()
            }
        }
    }
    func renderCoffee(_ d:[String:Any],finished:Bool) {
        let ip=d["ip"] as? String ?? ""
        coffeeIP=ip
        let score=d["score"] as? String ?? ""
        let props=d["props"] as? [String:String] ?? [:]
        let dns=d["dns"] as? [String:String] ?? [:]
        let udp=d["udp"] as? [String:String] ?? [:]
        let pending=finished ? "未验证" : "检测中…"
        let tokens=score.split(whereSeparator:{$0.isWhitespace})
        if !ip.isEmpty,let first=tokens.first,let value=Int(first),(0...100).contains(value) {
            scoreValue.stringValue="\(value) / 100";scoreDetail.stringValue=tokens.dropFirst().joined(separator:" ")
        } else { scoreValue.stringValue="—";scoreDetail.stringValue=pending }
        propertyValue.stringValue=props["IP 属性"].flatMap{$0.isEmpty ? nil:$0} ?? pending
        propertyDetail.stringValue=ip.isEmpty ? "出口 IP 未验证" : ip
        dnsValue.stringValue="DNS · \(dns["状态"].flatMap{$0.isEmpty ? nil:$0} ?? pending)"
        udpValue.stringValue="UDP · \(udp["状态"].flatMap{$0.isEmpty ? nil:$0} ?? pending)"
        let udpIP=udp["UDP 出口"] ?? udp["UDP 出口 IP"] ?? ""
        leakDetail.stringValue=udpIP.isEmpty ? "" : "UDP \(udpIP)"
        let format=DateFormatter();format.dateFormat="HH:mm:ss"
        onlineStamp.stringValue="Net.Coffee \(format.string(from:Date())) · \(finished ? "已检测" : "检测中")"
        if let error=d["error"] as? String { onlineStamp.stringValue="Net.Coffee · 未验证：\(error)" }
        renderOverview()
    }
    func renderOverview() {
        let address=ipSummary.stringValue
        let matched = !coffeeIP.isEmpty && coffeeIP == address
        let mismatch = !coffeeIP.isEmpty && address.first?.isNumber == true && !matched
        let attribute = matched ? propertyValue.stringValue : (mismatch ? "检测出口不一致" : "IP 属性待验证")
        identityLine.stringValue=address
        identityType.stringValue=attribute
        healthScore.stringValue=matched ? scoreValue.stringValue : "待验证"
        scoreBar.doubleValue=matched ? Double(scoreValue.stringValue.split(separator:"/").first?.trimmingCharacters(in:.whitespaces) ?? "") ?? 0 : 0
        sourceLine.stringValue=matched ? "ipwho.is · Net.Coffee" : "ipwho.is"
        scoreBar.needsDisplay=true
        updatedTime.stringValue=onlineStamp.stringValue.split(separator:" ").dropFirst().first.map(String.init) ?? "—"
        dnsValue.stringValue=dnsValue.stringValue.replacingOccurrences(of:"未检测到泄露",with:"未见泄漏").replacingOccurrences(of:"未检测到泄漏",with:"未见泄漏")
        udpValue.stringValue=udpValue.stringValue.replacingOccurrences(of:"未检测到泄露",with:"未见泄漏").replacingOccurrences(of:"未检测到泄漏",with:"未见泄漏")
        if mismatch { sourceLine.stringValue="检测出口不一致" }
    }
    @objc func reports() { let path = base.appendingPathComponent("proxy-self-check/reports"); try? FileManager.default.createDirectory(at:path,withIntermediateDirectories:true); NSWorkspace.shared.open(path) }
    @objc func help() { NSWorkspace.shared.open(base.appendingPathComponent("使用说明.md")) }
    func applicationWillTerminate(_ notification:Notification) { hourlyTestTimer?.invalidate();chainTimer?.invalidate() }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true) }
    func windowShouldClose(_ sender:NSWindow)->Bool { sender.orderOut(nil);return false }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool { showWindow();return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
final class CoffeeReader: NSObject, WKNavigationDelegate {
    let base:URL
    var web:WKWebView?
    var timer:Timer?
    var rounds=0
    var done=false
    var extracting=false
    var last:[String:Any]=[:]
    let callback:([String:Any],Bool)->Void
    init(base:URL,callback:@escaping ([String:Any],Bool)->Void) { self.base=base;self.callback=callback }
    func start() {
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        let view=WKWebView(frame:NSRect(x:0,y:0,width:1024,height:768),configuration:config)
        web=view;view.navigationDelegate=self
        view.load(URLRequest(url:URL(string:"https://ip.net.coffee/claude/")!,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20))
        timer=Timer.scheduledTimer(withTimeInterval:1.5,repeats:true) { [weak self] _ in self?.poll() }
    }
    func poll() {
        guard !done else { return }
        rounds += 1
        if rounds>=30 { finish(last); return }
        guard !extracting,let view=web else { return }
        guard let script=try? String(contentsOf:base.appendingPathComponent("coffee-extract.js"),encoding:.utf8) else { finish(["error":"缺少页面字段解析文件"]);return }
        extracting=true
        view.evaluateJavaScript(script) { [weak self] value,error in
            guard let self=self,!self.done else { return }
            self.extracting=false
            guard let d=value as? [String:Any] else { return }
            self.last=d
            let ip=d["ip"] as? String ?? ""
            let score=d["score"] as? String ?? ""
            let props=d["props"] as? [String:String] ?? [:]
            let dns=d["dns"] as? [String:String] ?? [:]
            let udp=d["udp"] as? [String:String] ?? [:]
            let complete = !ip.isEmpty && !score.isEmpty && !(props["IP 属性"] ?? "").isEmpty && !(dns["状态"] ?? "").isEmpty && !(udp["状态"] ?? "").isEmpty
            if complete { self.finish(d) } else { self.callback(d,false) }
        }
    }
    func finish(_ d:[String:Any]) { guard !done else{return};done=true;timer?.invalidate();timer=nil;callback(d,true);web?.stopLoading();web?.navigationDelegate=nil;web=nil }
    func cancel() { done=true;timer?.invalidate();timer=nil;web?.stopLoading();web?.navigationDelegate=nil;web=nil }
    deinit { timer?.invalidate() }
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) { finish(["error":error.localizedDescription]) }
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error) { finish(["error":error.localizedDescription]) }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
