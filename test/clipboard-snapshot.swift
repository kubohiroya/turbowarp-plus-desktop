// Preserve all pasteboard formats while the test uses the general OS clipboard.
import AppKit
import Foundation

struct Item: Codable {
    let types: [String: Data]
}

let board = NSPasteboard.general
let file = URL(fileURLWithPath: CommandLine.arguments[2])
if CommandLine.arguments[1] == "save" {
    let items = board.pasteboardItems?.map { item in
        Item(types: Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
            item.data(forType: type).map { (type.rawValue, $0) }
        }))
    } ?? []
    try JSONEncoder().encode(items).write(to: file, options: .atomic)
} else if let text = board.string(forType: .string),
          ["D4 counter", "# D4 source", "D4 ordinary clipboard text", "D5 clipboard costume", "D5 clipboard sound"].contains(where: text.contains) {
    let items = try JSONDecoder().decode([Item].self, from: Data(contentsOf: file))
    board.clearContents()
    board.writeObjects(items.map { saved in
        let item = NSPasteboardItem()
        for (type, value) in saved.types {
            item.setData(value, forType: NSPasteboard.PasteboardType(type))
        }
        return item
    })
}
