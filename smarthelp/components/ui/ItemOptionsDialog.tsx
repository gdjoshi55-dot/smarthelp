"use client";

import { useState } from "react";
import { X } from "lucide-react";

const DEFAULT_COMMON_OPTIONS = [
  "Spicy",
  "Hot",
  "Medium",
  "No Salt",
  "No Sugar",
  "Extra Spicy",
  "Less Spicy",
  "Less Oil",
  "Extra Cheese",
];

interface ItemOptionsDialogProps {
  item: {
    id: string;
    name: string;
    price: number;
    options?: string[];
  };
  commonOptions?: string[];
  onConfirm: (options: string[], notes: string) => void;
  onCancel: () => void;
}

export default function ItemOptionsDialog({
  item,
  commonOptions,
  onConfirm,
  onCancel,
}: ItemOptionsDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  const itemOptions = item.options || [];
  const restaurantOptions =
    commonOptions && commonOptions.length > 0
      ? commonOptions
      : DEFAULT_COMMON_OPTIONS;
  const options = [
    ...itemOptions,
    ...restaurantOptions.filter((o) => !itemOptions.includes(o)),
  ];

  const toggleOption = (option: string) => {
    setSelected((prev) =>
      prev.includes(option)
        ? prev.filter((o) => o !== option)
        : [...prev, option]
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">{item.name}</h3>
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <p className="text-gray-600 text-sm mb-5">
            Price: <span className="font-semibold text-gray-900">{item.price}</span>
          </p>

          {(options.length > 0 || selected.length > 0) && (
            <div className="mb-5">
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Options
              </h4>
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => toggleOption(option)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                      selected.includes(option)
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}

          {options.length === 0 && selected.length === 0 && (
            <p className="text-sm text-gray-500 mb-5">
              Choose any options you like, or just leave them blank.
            </p>
          )}

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Special Instructions / Remarks
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. spicy extra sambar, no onions..."
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
            />
          </div>

          <div className="flex space-x-3">
            <button
              onClick={onCancel}
              className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(selected, notes.trim())}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add to Cart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
