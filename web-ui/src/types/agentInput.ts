export type AgentInputItem =
  | {
      type: "text";
      text: string;
      textElements: [];
      text_elements: [];
    }
  | {
      type: "image";
      url: string;
      detail?: "high" | "original";
    }
  | {
      type: "skill";
      id: string;
      label: string;
      value: string;
      executable: boolean;
      options?: {
        imageModel?: string;
      };
    };
